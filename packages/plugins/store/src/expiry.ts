import type { ProviderServiceContext } from '@stackpanel/sdk';
import { context, logger } from './context';
import {
  claimExpiryStage,
  getProduct,
  listDueExpiryReminders,
  listExpiringServices,
  markExpiryFailure,
  patchServiceInstance,
  type ServiceInstanceRecord,
} from './repository';
import { providerForProduct } from './fulfillment';

/**
 * 到期自动化（expiry sweep）。
 *
 * 魔方 V10 的云服务器生命周期：到期提醒 →（宽限期内仍可用）→ 暂停（保留期，
 * 资源不可用但数据保留）→ 终止（释放）。本模块以周期任务实现同一闭环，全程
 * 走交付物的到期阶段（`expiryStage`）保证每个阶段对同一服务只动作一次。
 *
 * 阶段：null → `reminded` → `suspending` → `suspended` → `terminating` → `terminated`。
 * `suspending`/`terminating` 表示已认领但**尚未确认上游**：上游调用失败时停留在此，
 * 下一轮 sweep 可重试；只有上游成功才推进到 `suspended`/`terminated` 终态。服务一旦
 * 续费，阶段被重置为 null（见 renewal.ts），新的到期时间自然会重新走一遍。
 */

/** 到期前提醒窗口（天）。 */
export const EXPIRY_REMIND_DAYS = 7;
/** 到期后的宽限期（毫秒）：期间仍可用，仅提醒。 */
export const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
/** 暂停后的保留期（毫秒）：期间资源不可用但数据保留，超期终止。 */
export const RETENTION_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
/** 单轮扫描处理条数上限。 */
export const EXPIRY_SWEEP_BATCH = 50;
/** 到期扫描周期（毫秒）：每小时一次。 */
export const EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** 上游到期动作最大自动重试次数（超过后停止自动重试并告警）。 */
export const EXPIRY_MAX_ATTEMPTS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 到期扫描入口：由内核周期任务调用（集群下单次执行）。 */
export async function runExpirySweep(now: Date = new Date()): Promise<void> {
  const nowMs = now.getTime();
  await remindUpcoming(nowMs);
  await processExpired(nowMs);
}

/** 1) 到期前提醒：窗口内且尚未提醒过的 ACTIVE 服务。 */
async function remindUpcoming(nowMs: number): Promise<void> {
  const windowEnd = nowMs + EXPIRY_REMIND_DAYS * DAY_MS;
  const due = await listDueExpiryReminders(nowMs, windowEnd, EXPIRY_SWEEP_BATCH);
  for (const service of due) {
    if (service.expiryStage) continue; // 已提醒/已进入后续阶段
    const claimed = await claimExpiryStage(service.id, null, 'reminded');
    if (!claimed) continue;
    await notify(service, {
      type: 'service.expiring',
      title: '云服务即将到期',
      body: `「${service.productName}」将于 ${formatDate(service.expiresAt)} 到期，请及时续费。`,
      link: `/account/services/${service.id}`,
      data: {
        serviceId: service.id,
        expiresAt: service.expiresAt?.toISOString() ?? null,
      },
    });
    logger().info(`store: expiry reminder sent for service ${service.id}`);
  }
}

/** 2) 到期后处理：宽限期结束→暂停；保留期结束→终止。 */
async function processExpired(nowMs: number): Promise<void> {
  const expired = await listExpiringServices(nowMs, EXPIRY_SWEEP_BATCH);
  for (const service of expired) {
    const expiresMs = service.expiresAt?.getTime() ?? 0;
    const graceEnds = expiresMs + GRACE_PERIOD_MS;
    const retentionEnds = graceEnds + RETENTION_PERIOD_MS;

    if (service.status === 'ACTIVE') {
      if (nowMs < graceEnds) continue; // 宽限期内：仅提醒过，保持可用
      await suspendExpired(service);
      continue;
    }
    if (service.status === 'SUSPENDED') {
      if (nowMs < retentionEnds) continue; // 保留期内：资源不可用但保留数据
      await terminateExpired(service);
    }
  }
}

async function suspendExpired(service: ServiceInstanceRecord): Promise<void> {
  // 认领：null | 'reminded' → 'suspending'（处理中）。已是 'suspending' 时走重试分支。
  const claimed =
    service.expiryStage === 'suspending'
      ? true
      : await claimExpiryStage(service.id, service.expiryStage === 'reminded' ? 'reminded' : null, 'suspending');
  if (!claimed) return;

  // 已达重试上限：停止自动重试，仅告警（不落成功态）。
  if ((service.expiryAttempts ?? 0) >= EXPIRY_MAX_ATTEMPTS) {
    logger().error(
      `store: expiry suspend gave up for ${service.id} after ${service.expiryAttempts} attempts: ${service.expiryLastError ?? '未知错误'}`,
    );
    return;
  }

  // 外部副作用：失败则记录、不落终态、不发通知，停在 suspending 待下轮重试。
  try {
    await callProviderHook(service, 'suspend');
  } catch (error) {
    await markExpiryFailure(service.id, 'suspending', error);
    logger().warn(
      `store: expiry suspend provider hook failed for ${service.id}: ${messageOf(error)}`,
    );
    return;
  }

  // 上游确认成功：落终态 + 清重试状态（条件匹配处理中阶段，防并发覆盖）。
  const patched = await patchServiceInstance(service.id, 'suspending', {
    state: { set: 'SUSPENDED' },
    expiryStage: { set: 'suspended' },
    expiryAttempts: { set: 0 },
    expiryLastError: { set: null },
  });
  if (!patched) return;
  await notify(service, {
    type: 'service.suspended',
    title: '云服务已暂停',
    body: `「${service.productName}」已过宽限期仍未续费，服务已暂停（保留期内数据保留）。续费后自动恢复。`,
    link: `/account/services/${service.id}`,
    data: { serviceId: service.id },
  });
  logger().info(`store: service ${service.id} suspended (expired)`);
}

async function terminateExpired(service: ServiceInstanceRecord): Promise<void> {
  // 认领：'suspended' → 'terminating'（处理中）。已是 'terminating' 时走重试分支。
  const claimed =
    service.expiryStage === 'terminating'
      ? true
      : await claimExpiryStage(service.id, 'suspended', 'terminating');
  if (!claimed) return;

  // 已达重试上限：停止自动重试，仅告警（不落成功态）。
  if ((service.expiryAttempts ?? 0) >= EXPIRY_MAX_ATTEMPTS) {
    logger().error(
      `store: expiry terminate gave up for ${service.id} after ${service.expiryAttempts} attempts: ${service.expiryLastError ?? '未知错误'}`,
    );
    return;
  }

  // 外部副作用：失败则记录、不落终态、不发通知，停在 terminating 待下轮重试。
  try {
    await callProviderHook(service, 'terminate');
  } catch (error) {
    await markExpiryFailure(service.id, 'terminating', error);
    logger().warn(
      `store: expiry terminate provider hook failed for ${service.id}: ${messageOf(error)}`,
    );
    return;
  }

  const patched = await patchServiceInstance(service.id, 'terminating', {
    state: { set: 'TERMINATED' },
    expiryStage: { set: 'terminated' },
    expiryAttempts: { set: 0 },
    expiryLastError: { set: null },
    terminatedAt: { set: new Date().toISOString() },
  });
  if (!patched) return;
  await notify(service, {
    type: 'service.terminated',
    title: '云服务已终止',
    body: `「${service.productName}」保留期结束，服务已终止。`,
    link: `/account/services/${service.id}`,
    data: { serviceId: service.id },
  });
  logger().info(`store: service ${service.id} terminated (retention elapsed)`);
}

async function callProviderHook(
  service: ServiceInstanceRecord,
  action: 'suspend' | 'terminate',
): Promise<void> {
  const product = await getProduct(service.productId);
  const provider = providerForProduct({
    providerId: service.providerId ?? product?.providerId ?? null,
    fulfillmentType: service.fulfillmentType,
  });
  if (!provider) return;
  const hook = action === 'suspend' ? provider.suspend : provider.terminate;
  if (!hook) return;
  const ctx: ProviderServiceContext = {
    service: {
      id: service.id,
      providerId: service.providerId,
      providerServiceId: service.providerServiceId,
      runtime: service.runtime,
      credentialsRef: service.credentialsRef,
      userId: service.userId,
      orderId: service.orderId,
      productId: service.productId,
      productName: service.productName,
      status: service.status,
    },
    secrets: context().secrets,
  };
  await hook.call(provider, ctx);
}

interface NotifyInput {
  type: string;
  title: string;
  body: string;
  link: string;
  data: Record<string, unknown>;
}

/** 站内通知（通知服务不可用时静默：不影响生命周期推进）。 */
async function notify(service: ServiceInstanceRecord, input: NotifyInput): Promise<void> {
  try {
    await context().notifications.create({
      userId: service.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.link,
      data: input.data,
    });
  } catch (error) {
    logger().warn(`store: expiry notification failed for ${service.id}: ${messageOf(error)}`);
  }
}

function formatDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '未知时间';
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}
