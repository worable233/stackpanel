import type { NotificationStatus, ProviderServiceContext } from '@stackpanel/sdk';
import { context, logger } from './context';
import {
  claimExpiryStage,
  getProduct,
  listExpiringServices,
  listReminderCandidates,
  markExpiryFailure,
  patchServiceInstance,
  resetExpiryStage,
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 到期提醒链（对标 #12.5）。
 *
 * 每一档都是一次 `expiryStage` 的 CAS 迁移：`null → reminded → reminded-final →
 * overdue-1 → overdue-2`（然后进 `suspending`）。所以「提醒几次」是这张表决定的，
 * 而「同一档只发一次、失败可重试」是 `claimExpiryStage` 保证的 —— 两者解耦。
 *
 * 对标差异：ZJMF 是「到期前 2 次 + 到期后 3 次」，但它的宽限期比我们长（按天可配）。
 * 我方宽限期固定 3 天，硬塞 3 次逾期提醒会让最后一档和「已暂停」通知在同一轮发出，
 * 用户同时收到两条相反的信息。所以逾期只排 2 档，第 3 次由「已暂停」通知承担。
 * 要改回 3 档，加一行即可。
 */
export interface ExpiryReminderStep {
  /** 认领成功后写入 `expiryStage` 的阶段名，同时是下一档的前置阶段。 */
  stage: string;
  /** 相对到期的偏移（毫秒）：负数=到期前，正数=到期后。 */
  offsetMs: number;
  type: 'service.expiring' | 'service.overdue';
  title: string;
  body: (service: ServiceInstanceRecord) => string;
}

const FIRST_REMINDER_OFFSET_MS = -7 * DAY_MS;

export const EXPIRY_REMINDER_STEPS: readonly ExpiryReminderStep[] = [
  {
    stage: 'reminded',
    offsetMs: FIRST_REMINDER_OFFSET_MS,
    type: 'service.expiring',
    title: '云服务即将到期',
    body: (service) =>
      `「${service.productName}」将于 ${formatDate(service.expiresAt)} 到期，请及时续费。`,
  },
  {
    stage: 'reminded-final',
    offsetMs: -1 * DAY_MS,
    type: 'service.expiring',
    title: '云服务明日到期',
    body: (service) =>
      `「${service.productName}」将于 ${formatDate(service.expiresAt)} 到期。到期后有 3 天宽限期，逾期未续费将暂停服务。`,
  },
  {
    stage: 'overdue-1',
    offsetMs: 1 * DAY_MS,
    type: 'service.overdue',
    title: '云服务已到期',
    body: (service) =>
      `「${service.productName}」已于 ${formatDate(service.expiresAt)} 到期，仍在宽限期内，请尽快续费。`,
  },
  {
    stage: 'overdue-2',
    offsetMs: 2 * DAY_MS,
    type: 'service.overdue',
    title: '云服务即将暂停',
    body: (service) =>
      `「${service.productName}」宽限期仅剩 1 天，逾期未续费将暂停服务（暂停后保留数据 7 天，续费可恢复）。`,
  },
];

/** 提醒链的所有阶段名（`suspending` 认领时需要认出「仍在提醒阶段」）。 */
export const REMINDER_STAGES: readonly string[] = EXPIRY_REMINDER_STEPS.map((step) => step.stage);

/** 到期前提醒窗口（天），由提醒链的第一档推导，供查询窗口复用。 */
export const EXPIRY_REMIND_DAYS = -FIRST_REMINDER_OFFSET_MS / DAY_MS;
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

/** 到期扫描入口：由内核周期任务调用（集群下单次执行）。 */
export async function runExpirySweep(now: Date = new Date()): Promise<void> {
  const nowMs = now.getTime();
  await remindUpcoming(nowMs);
  await processExpired(nowMs);
}

/**
 * 1) 到期提醒链：按阶段逐档推进。
 *
 * 每档单独查询 + 单独限批（`listReminderCandidates`），一档积压不会把后面的档饿死。
 * 同一轮里可以连推多档（例如服务停机三天，恢复后一次性补发），这是**有意的**：
 * 漏发的提醒比迟发的提醒更糟。每档仍然是「先 CAS 认领再发通知」，所以重复执行
 * 不会重复发；通知失败则把阶段退回上一档，下一轮重试。
 */
async function remindUpcoming(nowMs: number): Promise<void> {
  let previous: string | null = null;
  for (const step of EXPIRY_REMINDER_STEPS) {
    const due = await listReminderCandidates(previous, nowMs - step.offsetMs, EXPIRY_SWEEP_BATCH);
    for (const service of due) {
      const claimed = await claimExpiryStage(service.id, previous, step.stage);
      if (!claimed) continue;
      const delivered = await notify(service, {
        type: step.type,
        title: step.title,
        body: step.body(service),
        link: `/account/services/${service.id}`,
        data: {
          serviceId: service.id,
          expiresAt: service.expiresAt?.toISOString() ?? null,
          reminderStage: step.stage,
        },
      });
      if (!delivered) {
        // 退回上一档（不是无条件置空）：否则前面的提醒会被重发。
        await resetExpiryStage(service.id, step.stage, previous);
        logger().warn(
          `store: expiry reminder (${step.stage}) not delivered for ${service.id}; stage released for retry`,
        );
        continue;
      }
      logger().info(`store: expiry reminder (${step.stage}) sent for service ${service.id}`);
    }
    previous = step.stage;
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
  // 认领：仍在提醒链上（或尚未进入任何阶段）→ 'suspending'（处理中）。
  // 已是 'suspending' 时走重试分支。
  const current = service.expiryStage ?? null;
  const claimable = current === null || REMINDER_STAGES.includes(current);
  const claimed =
    service.expiryStage === 'suspending' ? true : claimable && (await claimExpiryStage(service.id, current, 'suspending'));
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
  const hook = provider ? (action === 'suspend' ? provider.suspend : provider.terminate) : undefined;
  // 该服务是否期望外部生命周期动作：绑定了上游（providerId / providerServiceId）。
  // 若是，却解析不到提供方或提供方未实现该钩子，说明上游其实**什么都没做**——必须抛出
  // 以留在「处理中」阶段重试，绝不能静默当作成功（否则会落终态并向用户谎报「已暂停/
  // 已终止」，属审计 §4 的「上游失败仍报成功」）。本地交付物（无任何上游绑定）无外部
  // 副作用，保持 no-op 成功。
  const expectsUpstream = Boolean(service.providerId || service.providerServiceId);
  if (!provider || !hook) {
    if (expectsUpstream) {
      throw new Error(
        `未找到可执行 ${action} 的上游提供方（providerId=${service.providerId ?? 'null'}）`,
      );
    }
    return;
  }
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
      expiresAt: service.expiresAt ? service.expiresAt.toISOString() : null,
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
  status?: NotificationStatus;
}

/**
 * 站内通知（通知服务不可用时静默：不影响生命周期推进）。返回是否成功写入，
 * 供调用方决定是否回退到期阶段以重投（提醒场景）。
 */
async function notify(service: ServiceInstanceRecord, input: NotifyInput): Promise<boolean> {
  try {
    await context().notifications.create({
      userId: service.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.link,
      data: input.data,
      ...(input.status ? { status: input.status } : {}),
    });
    return true;
  } catch (error) {
    logger().warn(`store: expiry notification failed for ${service.id}: ${messageOf(error)}`);
    return false;
  }
}

function formatDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '未知时间';
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}
