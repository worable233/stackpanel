import type {
  CheckoutSelection,
  FulfillmentProvider,
  HttpRequest,
  MetricSeries,
  ProvisionContext,
  ProviderServiceContext,
  ServiceChangeInput,
  ServiceDetail,
  ServiceRenewalInput,
} from '@stackpanel/sdk';
import { EXTENSION_POINTS, readCheckoutConfig } from '@stackpanel/sdk';
import { bus, context, logger, runTransaction } from './context';
import { z } from 'zod';
import { deliveryTaskModel, orderModel, serviceInstanceModel, type StoreDeliveryTaskData, type StoreServiceInstanceData } from './data';
import { notifyAdmins, notifyUser } from './notifications';
import { StoreError } from './errors';
import { storeSettings } from './settings';
import { auditActor, recordStoreAudit } from './audit';
import { stockItems } from './errors';
import { productTypeById } from './product-types';
import { initialExpiryAt } from './utils';
import {
  claimTask,
  approveDeliveryTask,
  createServiceInstance,
  createTaskInstance,
  getOrder,
  getProduct,
  getService,
  getTask,
  listDueTasks,
  listServicesByUser,
  listServicesPage,
  listStaleRunningTasks,
  listTasksByOrder,
  listTasksPage,
  reclaimTask,
  replaceServiceInstance,
  replaceTask,
  retryFailedTask,
  toServiceInstanceData,
  toTaskData,
  type ServiceInstanceRecord,
} from './repository';

/** 认领任务的租约时长：超时未完成即视为认领者已死，可被回收重试。 */
const TASK_LEASE_MS = 5 * 60 * 1000;

const FULFILLMENT_POINT = EXTENSION_POINTS.fulfillmentProvider;
export const FULFILLMENT_POLL_INTERVAL_MS = 5_000;

/** secrets key 前缀：<pluginId>.fulfillment.<serviceId> 由内核隔离，这里用统一前缀。 */
function credentialsKey(serviceId: string): string {
  return `fulfillment.${serviceId}`;
}

/** 找到实现某商品履约的提供方（按 product.providerId 匹配）。 */
function providerById(providerId: string | null): FulfillmentProvider | null {
  if (!providerId) return null;
  return (
    context()
      .getExtensions<FulfillmentProvider>(FULFILLMENT_POINT)
      .find((provider) => provider.id === providerId) ?? null
  );
}

/**
 * 解析商品的履约提供方：优先 product.providerId（外部上游/类型插件），
 * 无 providerId 时回退到该商品类型插件的本地履约（本平台即上游/占位）。
 */
export function providerForProduct(product: {
  providerId: string | null;
  fulfillmentType: string;
}): FulfillmentProvider | null {
  return providerById(product.providerId) ?? productTypeById(product.fulfillmentType) ?? null;
}

interface TaskProductSnapshot {
  name: string;
  price: number;
  currency: string;
  metadata: unknown;
  providerProductId: string | null;
  config?: unknown;
}

/**
 * 为已支付订单的每一行创建异步履约任务，并立即触发一轮处理。
 * 由 `order.paid` 事件驱动（钱包即时支付与外部结算回调都会发布该事件）。
 */
export async function enqueueOrderFulfillment(orderId: string): Promise<void> {
  const order = await getOrder(orderId);
  if (!order || order.status !== 'PAID') return;
  const policy = await storeSettings();
  // 续费行不产生交付任务（服务已存在），改由 renewal 模块顺延到期时间。
  const { applyRenewalOrder } = await import('./renewal');
  const { applyChangeOrder } = await import('./changes');
  // 入队幂等：`order.paid` 是 at-least-once（重放回调、结算重试都会再次触发），
  // 同一 (orderId, productId) 只能有一个履约任务，否则会重复开通。
  const existing = await listTasksByOrder(orderId);
  const seen = new Set<string>();
  let hasRenewal = false;
  let hasChange = false;
  for (const line of stockItems(order)) {
    if (line.renewalServiceId) {
      hasRenewal = true;
      continue;
    }
    if (line.changeServiceId) {
      hasChange = true;
      continue;
    }
    if (seen.has(line.productId)) continue;
    const product = await getProduct(line.productId);
    if (!product) continue;
    seen.add(line.productId);
    // Never expand a legacy batch: it may already have created all remote units.
    if (existing.some(task => task.productId === line.productId && task.quantity > 1)) continue;
    for (let unitIndex = 0; unitIndex < line.quantity; unitIndex++) {
    const snapshot: TaskProductSnapshot = {
      name: product.name,
      price: line.price ?? product.price,
      currency: product.currency,
      metadata: product.metadata,
      providerProductId: product.providerProductId,
      ...(line.config !== undefined && line.config !== null ? { config: line.config } : {}),
    };
    const createdTask = await createTaskInstance({
      orderId: order.id,
      productId: product.id,
      userId: order.userId,
      productName: product.name,
      fulfillmentType: product.fulfillmentType,
      providerId: product.providerId,
      quantity: 1,
      state: policy.provisioningMode === 'manual' ? 'AWAITING_APPROVAL' : 'PENDING',
      attempts: 0,
      maxAttempts: 3,
      error: null,
      payload: snapshot,
      serviceId: null,
      nextAttemptAtMs: 0,
    }, unitIndex);
    // Make a paid instance visible before the provider finishes provisioning.
    // Deterministic instance identity also deduplicates concurrent initialization.
    if (!createdTask.serviceId) {
      await createServiceInstance(
        {
          userId: order.userId,
          orderId: order.id,
          productId: product.id,
          productName: (line.config as CheckoutSelection | undefined)?.instanceName ?? product.name,
          fulfillmentType: product.fulfillmentType,
          providerId: product.providerId,
          providerServiceId: null,
          state: createdTask.status === 'AWAITING_APPROVAL' ? 'AWAITING_APPROVAL' : 'PROVISIONING',
          credentialsRef: null,
          runtime: mergeRuntime(undefined, line.config as CheckoutSelection | undefined),
          amount: line.price ?? product.price,
          currency: product.currency,
          provisionedAt: null,
        },
        `instance-${createdTask.id}`,
      );
    }
    }
  }
  if (hasRenewal) {
    await applyRenewalOrder(orderId).catch((error) => {
      logger().error(`store: renewal apply failed for ${orderId}: ${messageOf(error)}`);
    });
  }
  if (hasChange) {
    await applyChangeOrder(orderId).catch((error) => {
      logger().error(`store: change apply failed for ${orderId}: ${messageOf(error)}`);
    });
  }
  await processDue().catch((error) => {
    logger().error(`store: fulfillment kick failed for ${orderId}: ${messageOf(error)}`);
  });
}

/**
 * 消费一轮到期的 PENDING 任务（带 DB 乐观锁，避免并发重复执行）。
 * 由内核任务 `fulfillment-poll` 周期调用（见 index.ts），集群下只执行一次。
 */
export async function processDue(): Promise<void> {
  const nowMs = Date.now();
  // 回收超租约仍 RUNNING 的任务（认领者崩溃/被 kill），避免永久卡住。
  // 逐条兜底：单个任务的回收/执行失败不应中断整轮（否则一条坏任务会卡死后续所有任务）。
  const stale = await listStaleRunningTasks(nowMs, 20);
  for (const task of stale) {
    try {
      // A timed-out upstream request may have succeeded. Never blindly replay provision.
      await reclaimTask(task.id, nowMs, false);
    } catch (error) {
      logger().error(`store: reclaim stale task ${task.id} failed: ${messageOf(error)}`);
    }
  }
  const due = await listDueTasks(nowMs, 20);
  for (const task of due) {
    try {
      const claimed = await claimTask(task.id, nowMs + TASK_LEASE_MS);
      if (!claimed) continue;
      await runTask(task.id);
    } catch (error) {
      logger().error(`store: run task ${task.id} failed: ${messageOf(error)}`);
    }
  }
}

async function runTask(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task || task.status !== 'RUNNING') return;
  const paidOrder = await getOrder(task.orderId);
  if (!paidOrder || paidOrder.status !== 'PAID') {
    await markTaskFailed(taskId, '订单未付款或已退款，禁止开通');
    return;
  }
  const product = await getProduct(task.productId);
  const provider = product ? providerForProduct(product) : null;

  if (!product || !provider) {
    await markTaskFailed(taskId, '未找到对应的履约提供方');
    return;
  }

  if (product.providerId !== task.providerId || ((task.payload as Partial<TaskProductSnapshot> | null)?.providerProductId !== undefined && (task.payload as Partial<TaskProductSnapshot>).providerProductId !== product.providerProductId)) {
    await markTaskFailed(taskId, '商品上游映射已变更，请核对原订单后处理');
    return;
  }
  const originalSource = (task.payload as { metadata?: { upstream?: { sourceRef?: string } } } | null)?.metadata?.upstream?.sourceRef;
  const currentSource = (product.metadata as { upstream?: { sourceRef?: string } } | null)?.upstream?.sourceRef;
  if (originalSource !== currentSource) {
    await markTaskFailed(taskId, '商品上游来源已变更，请核对原订单后处理');
    return;
  }

  const snapshot = (task.payload ?? {}) as Partial<TaskProductSnapshot>;
  const selection = (snapshot.config ?? null) as CheckoutSelection | null;
  const placeholder = await createServiceInstance(
    {
      userId: task.userId,
      orderId: task.orderId,
      productId: task.productId,
      productName: selection?.instanceName ?? task.productName,
      fulfillmentType: task.fulfillmentType,
      providerId: product.providerId,
      providerServiceId: null,
      state: 'PROVISIONING',
      credentialsRef: null,
      runtime: mergeRuntime(undefined, selection ?? undefined),
      amount: snapshot.price ?? product.price,
      currency: snapshot.currency ?? product.currency,
      provisionedAt: null,
    },
    task.serviceId ?? `instance-${task.id}`,
  );
  if (placeholder.status === 'AWAITING_APPROVAL') {
    await replaceServiceInstance(placeholder.id, {
      ...toServiceData(placeholder),
      state: 'PROVISIONING',
    });
  }
  // 周期商品的初始到期时间由 store 统一推算（唯一一套周期算法），先算后传给
  // 提供方，避免提供方自己再算一遍导致权益到期时间与商店展示不一致。
  const initialExpiry = initialExpiryAt(product.metadata, selection?.cycle, new Date());
  const provisionCtx: ProvisionContext = {
    fulfillmentId: task.id,
    recoveryGeneration: (task.payload as { recoveryGeneration?: number } | null)?.recoveryGeneration ?? 0,
    orderId: task.orderId,
    userId: task.userId,
    productId: task.productId,
    product: {
      id: product.id,
      name: product.name,
      price: product.price,
      currency: product.currency,
      metadata: product.metadata,
      providerId: product.providerId,
      providerProductId: product.providerProductId ?? snapshot.providerProductId ?? null,
    },
    quantity: task.quantity,
    ...(selection ? { config: selection } : {}),
    expiresAt: initialExpiry ? initialExpiry.toISOString() : null,
    secrets: context().secrets,
    resumePayment: placeholder.providerServiceId !== null && (task.payload as { resumePayment?: boolean } | null)?.resumePayment === true,
    checkpoint: async result => {
      if (!result.providerServiceId) throw new StoreError(409, '上游订单缺少实例标识，禁止付款');
      await runTransaction(async tx => {
        const currentTask = await tx.extensions.get<StoreDeliveryTaskData>(deliveryTaskModel, taskId);
        const current = await tx.extensions.get<StoreServiceInstanceData>(serviceInstanceModel, placeholder.id);
        if (!currentTask || !current || currentTask.spec.attempts !== task.attempts || !['RUNNING', 'REQUIRES_RECONCILIATION'].includes(currentTask.spec.state)) throw new StoreError(409, '开通任务已变更，禁止继续付款');
        if (current.spec.providerServiceId && current.spec.providerServiceId !== result.providerServiceId) throw new StoreError(409, '上游实例标识不一致，禁止覆盖');
        await tx.extensions.update(serviceInstanceModel, placeholder.id, {
          ...current.spec, providerServiceId: result.providerServiceId,
          state: result.runtime?.paid === true ? 'PROVISIONING' : 'AWAITING_UPSTREAM_PAYMENT',
          runtime: mergeRuntime(result.runtime, provisionCtx.config),
        }, { expectedVersion: current.version });
      });
    },
  };

  try {
    const result = await provider.provision(provisionCtx);
    // 周期商品按结账周期落一个初始到期时间（缺省取第一个周期）；永久商品为 null。
    // 异步开通（PENDING）也在下单时起算，避免上游开通后无到期时间。
    const awaitingPayment = result.runtime?.paid === false;
    const serviceExpiry = result.status !== 'FAILED' && !awaitingPayment ? initialExpiry : null;
    const serviceData = {
      userId: task.userId,
      orderId: task.orderId,
      productId: task.productId,
      productName: provisionCtx.config?.instanceName ?? task.productName,
      fulfillmentType: task.fulfillmentType,
      providerId: product.providerId,
      providerServiceId: result.providerServiceId ?? null,
      state:
        awaitingPayment ? 'AWAITING_UPSTREAM_PAYMENT' : result.status === 'ACTIVE'
          ? 'ACTIVE'
          : result.status === 'PENDING'
            ? 'PROVISIONING'
            : 'FAILED',
      credentialsRef: null,
      runtime: mergeRuntime(result.runtime, provisionCtx.config),
      amount: snapshot.price ?? product.price,
      currency: snapshot.currency ?? product.currency,
      ...(serviceExpiry ? { expiresAt: serviceExpiry.toISOString() } : {}),
      provisionedAt: result.status === 'ACTIVE' ? new Date().toISOString() : null,
    };
    await replaceServiceInstance(placeholder.id, { ...toServiceData(placeholder), ...serviceData });
    const service = (await getService(placeholder.id))!;

    let credentialsRef: string | null = null;
    if (result.credentialsRef) {
      credentialsRef = result.credentialsRef;
    } else if (result.credentials && Object.keys(result.credentials).length > 0) {
      const key = credentialsKey(service.id);
      await context().secrets.set(key, JSON.stringify(result.credentials));
      credentialsRef = key;
    }
    if (credentialsRef) {
      await replaceServiceInstance(service.id, toServiceData({ ...service, credentialsRef }));
    }

    await replaceTask(taskId, {
      ...toTaskData(task),
      state: awaitingPayment ? 'REQUIRES_RECONCILIATION' : result.status === 'FAILED' ? 'FAILED' : 'SUCCEEDED',
      serviceId: service.id,
      error: null,
    });
    if (awaitingPayment) {
      await notifyAdmins({ type: 'admin.service.provision.failed', title: '上游订单付款待处理', body: `订单 ${task.orderId} 已取得上游实例标识，但付款尚未确认，请处理原账单，禁止重新下单。`, link: '/admin/plugin/store/approvals', data: { orderId: task.orderId, serviceId: service.id } });
      return;
    }
    if (result.status === 'FAILED') return;
    // 开通结果通知用户（幂等键按订单+商品，重放/重试合并为一条）。异步开通（PENDING）
    // 标注「开通中」，真正终态由上游回调或后续同步更新，这里不做虚假承诺。
    await notifyUser({
      userId: task.userId,
      type: result.status === 'ACTIVE' ? 'service.provisioned' : 'service.provisioning',
      title: result.status === 'ACTIVE' ? '服务已开通' : '服务开通中',
      body:
        result.status === 'ACTIVE'
          ? `「${task.productName}」已开通，可在「我的服务」中查看。`
          : `「${task.productName}」正在开通，完成后会再次通知你。`,
      link: `/account/services/${service.id}`,
      data: { serviceId: service.id, orderId: task.orderId, status: service.status },
      status: result.status === 'ACTIVE' ? 'success' : 'active',
      dedupeKey: `store:provision:${task.orderId}:${task.productId}`,
    });
  } catch (error) {
    const message = messageOf(error);
    if ((error as { retryableBeforeSubmit?: boolean })?.retryableBeforeSubmit === true) {
      // Provider guarantees this invocation never submitted a remote mutation.
      await replaceTask(taskId, { ...toTaskData(task), state: 'PENDING', error: message, nextAttemptAtMs: Date.now() + 30_000 });
      return;
    }
    // Notifications/credential persistence can fail after provision succeeded.
    // Preserve the recorded upstream identity and never downgrade it or replay provision.
    const recorded = await getService(placeholder.id);
    if (recorded?.providerServiceId) {
      await replaceTask(taskId, {
        ...toTaskData(task),
        state: recorded.status === 'AWAITING_UPSTREAM_PAYMENT' ? 'REQUIRES_RECONCILIATION' : recorded.status === 'FAILED' ? 'FAILED' : 'SUCCEEDED',
        serviceId: recorded.id,
        error: message,
      });
      logger().error(
        `store: post-provision persistence/notification failure ${taskId}: ${message}`,
      );
      return;
    }
    {
      await replaceTask(taskId, {
        ...toTaskData(task),
        // An exception is not evidence that the upstream did not accept the order.
        state: 'REQUIRES_RECONCILIATION',
        error: message,
        nextAttemptAtMs: 0,
      });
      await replaceServiceInstance(placeholder.id, {
        ...toServiceData(placeholder),
        state: 'PROVISIONING',
        runtime: {
          ...((placeholder.runtime as Record<string, unknown>) ?? {}),
          provisioningReviewRequired: true,
        },
      });
      await notifyAdmins({
        type: 'admin.service.provision.failed', title: '开通结果待核对',
        body: `订单 ${task.orderId} 的开通结果未确认，请核对上游实例，禁止直接重试。`,
        link: '/admin/plugin/store/approvals',
        data: { orderId: task.orderId, productId: task.productId, userId: task.userId },
      }).catch(error => logger().error(`store: reconciliation notification failed: ${messageOf(error)}`));
    }
  }
}

async function markTaskFailed(taskId: string, message: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  await replaceTask(taskId, { ...toTaskData(task), state: 'FAILED', error: message });
}

/** Read-only upstream reconciliation; never calls provision again. */
/**
 * 结果未确认的任务自动重试（有界）。
 *
 * 安全性由提供方保证：标识丢失时提供方会**只读**反查上游账单——能定位就恢复原实例，
 * 定位不到就拒绝重新下单。所以重试不会多买一台；次数用尽后仍保留人工核对入口。
 */
export async function retryUnconfirmedProvisioning(nowMs = Date.now()): Promise<number> {
  const tasks = await context().extensions.listAll<StoreDeliveryTaskData>(deliveryTaskModel, {
    where: { state: { eq: 'REQUIRES_RECONCILIATION' }, nextAttemptAtMs: { lte: nowMs } },
  });
  let requeued = 0;
  for (const task of tasks) {
    if (task.spec.attempts >= task.spec.maxAttempts) {
      // 用尽后这里什么也不做，但必须说一次话：静默放弃会让「付了钱、没拿到机器」
      // 的单无声无息地留在待核对里（真实案例：上游购物车锁竞争把 3 次尝试烧光）。
      // 管理端任务列表用同一个判定打红标，这里再给运营发一次性站内信。
      if (!task.spec.exhaustedNotifiedAt) {
        logger().warn(
          `[store] 履约任务 ${task.name}（订单 ${task.spec.orderId}）自动重试用尽 ${task.spec.attempts}/${task.spec.maxAttempts}，需人工核对上游：确认无实例请在订单页退款`,
        );
        await notifyAdmins({
          type: 'admin.service.provision.failed',
          title: '订单开通自动重试用尽',
          body: `订单 ${task.spec.orderId} 开通结果仍未确认，自动重试已用尽 ${task.spec.attempts}/${task.spec.maxAttempts}。请核对上游是否存在实例：无实例则在订单页退款（声明上游无实例）。`,
          link: '/admin/plugin/store/approvals',
          data: { orderId: task.spec.orderId, taskId: task.name, attempts: task.spec.attempts },
        }).catch(error => logger().error(`store: exhaustion notification failed: ${messageOf(error)}`));
        await context().extensions.updateWhere(
          deliveryTaskModel,
          { name: { eq: task.name }, state: { eq: 'REQUIRES_RECONCILIATION' }, attempts: { eq: task.spec.attempts } },
          { exhaustedNotifiedAt: { set: new Date(nowMs).toISOString() } },
        ).catch(() => undefined);
      }
      continue;
    }
    // 退避：避免每次轮询都烧一次尝试次数，也避免对上游形成重试风暴。
    const delayMs = 300_000 * Math.max(1, task.spec.attempts);
    const { updated } = await context().extensions.updateWhere(
      deliveryTaskModel,
      {
        name: { eq: task.name },
        state: { eq: 'REQUIRES_RECONCILIATION' },
        attempts: { eq: task.spec.attempts },
      },
      { state: { set: 'PENDING' }, nextAttemptAtMs: { set: nowMs + delayMs } },
    );
    if (updated === 1) requeued += 1;
  }
  return requeued;
}

export async function reconcileProvisioning(): Promise<void> {
  // Snapshot pages before mutating states, otherwise offset pagination skips rows.
  const items: ServiceInstanceRecord[] = [];
  for (const state of ['PROVISIONING', 'AWAITING_UPSTREAM_PAYMENT']) {
    const first = await listServicesPage(1, 100, state);
    items.push(...first.items);
    for (let page = 2; page <= Math.ceil(first.total / 100); page++) {
      items.push(...(await listServicesPage(page, 100, state)).items);
    }
  }
  for (const service of items) {
    if (!service.providerServiceId) continue;
    try {
      const provider = providerForService(service);
      const detail = await provider?.getDetail?.(serviceContext(service));
      if (
        !detail?.status ||
        !['ACTIVE', 'SUSPENDED', 'FAILED', 'TERMINATED'].includes(detail.status)
      )
        continue;
      await runTransaction(async tx => {
        const current = await tx.extensions.get<StoreServiceInstanceData>(serviceInstanceModel, service.id);
        if (!current || current.spec.state !== service.status || current.spec.providerServiceId !== service.providerServiceId) return;
        // A remote service state is not proof of a financial transaction.
        // Preserve paymentState and the admin reconciliation task until the invoice is verified.
        await tx.extensions.update(serviceInstanceModel, service.id, {
          ...current.spec,
          state: detail.status!,
          provisionedAt: validProviderDate(detail.provisionedAt) ?? current.spec.provisionedAt ?? null,
          ...(validProviderDate(detail.expiresAt) ? {
            expiresAt: validProviderDate(detail.expiresAt)!,
            expiresAtMs: Date.parse(detail.expiresAt!),
          } : {}),
        }, { expectedVersion: current.version });
      });
    } catch (error) {
      logger().warn(`store: provisioning status ${service.id}: ${messageOf(error)}`);
    }
  }
}

function validProviderDate(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}

const toServiceData = toServiceInstanceData;

/** 把结账配置选择并入 runtime（供升配/续费/详情复用）。 */
function mergeRuntime(
  runtime: Record<string, unknown> | undefined,
  config: CheckoutSelection | undefined,
): Record<string, unknown> | null {
  const base = runtime && typeof runtime === 'object' ? runtime : {};
  if (!config || (!config.cycle && !config.selections && !config.instanceName)) {
    return Object.keys(base).length > 0 ? base : null;
  }
  return { ...base, ...(config.instanceName ? { instanceName: config.instanceName } : {}), config };
}

function serviceContext(service: ServiceInstanceRecord): ProviderServiceContext {
  return {
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
}

/** 供其它 store 模块（升配/转移/续费等）复用同一 provider 上下文。 */
export function providerServiceContext(service: ServiceInstanceRecord): ProviderServiceContext {
  return serviceContext(service);
}

/** 解析某服务的履约提供方（providerId 优先，回退到类型插件的本地履约）。 */
export function providerForService(service: ServiceInstanceRecord) {
  return providerById(service.providerId) ?? productTypeById(service.fulfillmentType) ?? null;
}

function requireOwnedService(service: ServiceInstanceRecord, userId: string): void {
  if (service.userId !== userId) throw new StoreError(404, '服务不存在');
}

/**
 * 对交付物执行生命周期动作，转发给其履约提供方的钩子。用户 API 与内核商业出口
 * 共用；调用方负责落状态真值。
 */
export async function applyServiceLifecycleAction(
  service: ServiceInstanceRecord,
  action: 'suspend' | 'resume' | 'terminate',
): Promise<void> {
  if (!['ACTIVE', 'SUSPENDED'].includes(service.status))
    throw new StoreError(409, '实例尚未开通，禁止执行生命周期操作');
  const provider = providerForProduct(service);
  if (!provider) return;
  const hook =
    action === 'suspend'
      ? provider.suspend
      : action === 'resume'
        ? provider.resume
        : provider.terminate;
  if (hook) await hook.call(provider, serviceContext(service));
}

/* ------------------------- 用户「我的服务」API ------------------------- */

async function visibleServiceStatus(service: ServiceInstanceRecord): Promise<string> {
  if (service.status !== 'PROVISIONING' || service.providerServiceId || !service.id.startsWith('instance-')) return service.status;
  const task = await getTask(service.id.slice('instance-'.length));
  return task?.status === 'REQUIRES_RECONCILIATION' ? 'REQUIRES_RECONCILIATION' : service.status;
}

export async function listMyServices(req: HttpRequest): Promise<unknown> {
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const services = await listServicesByUser(userId);
  const reviewStates = new Map(await Promise.all(services.map(async service => [service.id, await visibleServiceStatus(service)] as const)));
  const products = new Map(
    await Promise.all(
      [...new Set(services.map((service) => service.productId).filter(Boolean))].map(
        async (id) => [id, await getProduct(id)] as const,
      ),
    ),
  );
  return {
    services: services.map((service) => ({
      id: service.id,
      productName: service.productName,
      fulfillmentType: service.fulfillmentType,
      status: reviewStates.get(service.id) ?? service.status,
      runtime: service.runtime,
      configuration: (() => {
        const runtime = service.runtime as { config?: CheckoutSelection } | null;
        const selections = runtime?.config?.selections;
        if (!selections) return [];
        const config = readCheckoutConfig(products.get(service.productId)?.metadata);
        return (
          config?.options.flatMap((option) => {
            const selected = selections[option.id];
            if (
              option.type === 'quantity' &&
              typeof selected === 'number' &&
              Number.isFinite(selected)
            ) {
              return [{ label: option.label, value: `${selected}${option.unit ?? ''}` }];
            }
            const choice = option.choices?.find((item) => item.id === selected);
            return choice ? [{ label: option.label, value: choice.label }] : [];
          }) ?? []
        );
      })(),
      amount: service.amount,
      currency: service.currency,
      expiresAt: service.expiresAt,
      provisionedAt: service.provisionedAt,
      createdAt: service.createdAt,
    })),
  };
}

export async function getMyService(req: HttpRequest): Promise<unknown> {
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const service = await getService(id);
  if (!service) throw new StoreError(404, '服务不存在');
  requireOwnedService(service, userId);

  let detail: ServiceDetail | undefined;
  const provider = providerById(service.providerId) ?? productTypeById(service.fulfillmentType);
  if (provider?.getDetail && service.providerServiceId) {
    detail = await provider.getDetail(serviceContext(service));
    if (
      service.status === 'PROVISIONING' &&
      detail.status &&
      ['ACTIVE', 'FAILED'].includes(detail.status)
    ) {
      await replaceServiceInstance(service.id, {
        ...toServiceData(service),
        state: detail.status,
        provisionedAt: detail.status === 'ACTIVE' ? new Date().toISOString() : null,
      });
    }
  }
  return {
    service: {
      id: service.id,
      productId: service.productId,
      productName: service.productName,
      fulfillmentType: service.fulfillmentType,
      providerId: service.providerId,
      providerServiceId: service.providerServiceId,
      status: service.status === 'AWAITING_UPSTREAM_PAYMENT' ? service.status : detail?.status ?? await visibleServiceStatus(service),
      statusLabel: detail?.statusLabel ?? null,
      title: detail?.title ?? service.productName,
      runtime: service.runtime,
      amount: service.amount,
      currency: service.currency,
      expiresAt: service.expiresAt,
      provisionedAt: service.provisionedAt,
      createdAt: service.createdAt,
      detail: detail ?? { fields: [] },
    },
  };
}

export async function getMyServiceMetrics(req: HttpRequest): Promise<unknown> {
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const service = await getService(id);
  if (!service) throw new StoreError(404, '服务不存在');
  requireOwnedService(service, userId);
  const provider = providerById(service.providerId) ?? productTypeById(service.fulfillmentType);
  if (!provider?.getMetrics) return { metrics: [] };
  const metrics: MetricSeries[] = await provider.getMetrics(serviceContext(service));
  return { metrics };
}

export async function runMyServiceAction(req: HttpRequest): Promise<unknown> {
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const service = await getService(id);
  if (!service) throw new StoreError(404, '服务不存在');
  requireOwnedService(service, userId);
  if (!['ACTIVE', 'SUSPENDED'].includes(service.status))
    throw new StoreError(409, '实例尚未开通，禁止执行运维操作');
  const provider = providerById(service.providerId) ?? productTypeById(service.fulfillmentType);
  if (!provider?.executeAction) throw new StoreError(501, '该服务不支持此操作');
  const body = (req.body ?? {}) as { actionId?: unknown };
  const actionId = body.actionId;
  if (typeof actionId !== 'string' || !actionId) throw new StoreError(400, '缺少动作 ID');
  const ctx = serviceContext(service);
  // 除保留键外的标量字段视为动作参数（动作参数名由动作声明决定）。
  const params = collectActionParams(body);
  // 若提供方声明了该动作的参数，则只允许声明过的参数名，防止任意键透传到上游。
  const guarded = await restrictActionParams(provider, ctx, actionId, params);
  const result = await provider.executeAction(actionId, ctx, guarded);
  // 提供方返回的 runtime 补丁浅合并回服务（如电源状态、系统、密码更新时间）。
  if (result?.runtime && typeof result.runtime === 'object') {
    const merged = {
      ...toServiceInstanceData(service),
      runtime: { ...((service.runtime as Record<string, unknown>) ?? {}), ...result.runtime },
    };
    await replaceServiceInstance(service.id, merged);
  }
  return { ok: true, result: result ?? null };
}

/* ------------------------- 增值运维：服务子资源 ------------------------- */

/** 读取某服务可用的子资源种类（磁盘/快照/备份/网络/流量包…）。 */
export async function listMyServiceResourceKinds(req: HttpRequest): Promise<unknown> {
  const { service } = await requireOwnedServiceById(req);
  const provider = providerForService(service);
  if (!provider?.listResourceKinds) return { kinds: [] };
  const kinds = await provider.listResourceKinds(serviceContext(service));
  return { kinds: kinds.filter((kind) => resourceKindVisible(kind, service.runtime)) };
}

/** 按 runtime 字段条件过滤资源种类（如仅 VPC 显示流量包）。 */
function resourceKindVisible(
  kind: { visibleWhen?: { field: string; equals?: unknown; in?: readonly unknown[] } },
  runtime: unknown,
): boolean {
  const condition = kind.visibleWhen;
  if (!condition) return true;
  const value = ((runtime ?? {}) as Record<string, unknown>)[condition.field];
  if (condition.equals === undefined && (!condition.in || condition.in.length === 0)) {
    return value !== undefined && value !== null && value !== '';
  }
  if (value === undefined || value === null) return false;
  if (condition.equals !== undefined && String(value) === String(condition.equals)) return true;
  return Boolean(condition.in?.some((candidate) => String(candidate) === String(value)));
}

/** 列出某类子资源。 */
export async function listMyServiceResources(req: HttpRequest): Promise<unknown> {
  const { service } = await requireOwnedServiceById(req);
  const kind = req.params['kind'];
  if (!kind) throw new StoreError(400, '缺少资源类型');
  const provider = providerForService(service);
  if (!provider?.listResources) return { resources: [] };
  const resources = await provider.listResources(serviceContext(service), kind);
  return { resources };
}

/** 新建子资源（磁盘/快照/备份/IP…）。 */
export async function createMyServiceResource(req: HttpRequest): Promise<unknown> {
  const { service } = await requireOwnedServiceById(req);
  const kind = req.params['kind'];
  if (!kind) throw new StoreError(400, '缺少资源类型');
  const provider = providerForService(service);
  if (!provider?.createResource) throw new StoreError(501, '该服务不支持此操作');
  const ctx = serviceContext(service);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const params = collectActionParams(body);
  const guarded = await restrictResourceParams(provider, ctx, kind, 'create', params);
  const result = await provider.createResource(ctx, kind, guarded);
  await mergeActionResult(service, result);
  return { ok: true, result: result ?? null };
}

/** 对某子资源执行行内动作（扩容/挂载/删除/恢复…）。 */
export async function runMyServiceResourceAction(req: HttpRequest): Promise<unknown> {
  const { service } = await requireOwnedServiceById(req);
  const kind = req.params['kind'];
  const resourceId = req.params['resourceId'];
  const actionId = req.params['actionId'];
  if (!kind || !resourceId || !actionId) throw new StoreError(400, '缺少资源参数');
  const provider = providerForService(service);
  if (!provider?.runResourceAction) throw new StoreError(501, '该服务不支持此操作');
  const ctx = serviceContext(service);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const params = collectActionParams(body);
  const guarded = await restrictResourceParams(provider, ctx, kind, actionId, params);
  const result = await provider.runResourceAction(ctx, kind, resourceId, actionId, guarded);
  await mergeActionResult(service, result);
  return { ok: true, result: result ?? null };
}

/** 解析当前用户拥有的服务（按路由 `:id`）。 */
async function requireOwnedServiceById(
  req: HttpRequest,
): Promise<{ service: ServiceInstanceRecord }> {
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const service = await getService(id);
  if (!service) throw new StoreError(404, '服务不存在');
  requireOwnedService(service, userId);
  if (!['ACTIVE', 'SUSPENDED'].includes(service.status))
    throw new StoreError(409, '实例尚未开通，禁止执行资源操作');
  return { service };
}

/** 把提供方返回的 runtime 补丁浅合并回服务实例。 */
async function mergeActionResult(
  service: ServiceInstanceRecord,
  result: { runtime?: Record<string, unknown> } | void,
): Promise<void> {
  if (result && result.runtime && typeof result.runtime === 'object') {
    await replaceServiceInstance(service.id, {
      ...toServiceInstanceData(service),
      runtime: { ...((service.runtime as Record<string, unknown>) ?? {}), ...result.runtime },
    });
  }
}

/**
 * 限制子资源参数为提供方**声明**过的参数名（新建看 `createParams`，行内动作看
 * `rowActions[].params`）。未声明则放行，交由提供方自身参数校验兜底。
 */
async function restrictResourceParams(
  provider: FulfillmentProvider,
  ctx: ProviderServiceContext,
  kind: string,
  actionId: string,
  params: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  if (!params || !provider.listResourceKinds) return params;
  let declared: string[] | null = null;
  try {
    const kinds = await provider.listResourceKinds(ctx);
    const resource = kinds.find((candidate) => candidate.id === kind);
    if (resource) {
      const action =
        actionId === 'create'
          ? undefined
          : resource.rowActions?.find((candidate) => candidate.id === actionId);
      const declaredParams =
        actionId === 'create' ? resource.createParams : (action?.params ?? undefined);
      if (declaredParams) declared = declaredParams.map((param) => param.name);
    }
  } catch {
    return params;
  }
  if (declared === null) return params;
  for (const key of Object.keys(params)) {
    if (!declared.includes(key)) throw new StoreError(400, '动作参数无效');
  }
  return params;
}

/**
 * 应用配置变更（升配/降配/换商品）：调用提供方的 `changePackage`/`changeProduct`，
 * 合并返回的 runtime。由升级订单结算后调用。
 */
export async function applyServiceChange(
  service: ServiceInstanceRecord,
  change: {
    type: 'package' | 'product';
    config?: CheckoutSelection;
    targetProductId?: string;
    targetProviderProductId?: string | null;
  },
): Promise<boolean> {
  const provider = providerForService(service);
  if (!provider) return false;
  const ctx = serviceContext(service);
  const input: ServiceChangeInput = {
    ...(change.config ? { config: change.config } : {}),
    ...(change.targetProductId ? { targetProductId: change.targetProductId } : {}),
    ...(change.targetProviderProductId !== undefined
      ? { targetProviderProductId: change.targetProviderProductId }
      : {}),
  };
  const hook = change.type === 'product' ? provider.changeProduct : provider.changePackage;
  if (!hook) return false;
  const result = await hook.call(provider, ctx, input);
  await mergeActionResult(service, result);
  return true;
}

/** 续费回调：通知提供方到期时间已推进（尽力而为，失败不阻断）。 */
export async function notifyServiceRenewal(
  service: ServiceInstanceRecord,
  info: ServiceRenewalInput,
): Promise<void> {
  const provider = providerForService(service);
  if (!provider?.renew) return;
  await provider.renew(serviceContext(service), info);
}

/* ------------------------- 动作/资源参数校验 ------------------------- */

/**
 * 限制动作参数为该动作**声明**过的参数名。提供方经 `getDetail().actions[].params`
 * 声明每个动作接受哪些参数；未声明的键一律拒绝，防止任意键（乃至上游保留字段）
 * 被透传。若提供方未实现 `getDetail` 或详情不可用，则放行——此时仍由提供方自身的
 * 参数校验兜底（如 zjmf 的保留字段检查）。
 */
async function restrictActionParams(
  provider: FulfillmentProvider,
  ctx: ProviderServiceContext,
  actionId: string,
  params: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  if (!params || !provider.getDetail) return params;
  let declared: string[] | null = null;
  try {
    const detail = await provider.getDetail(ctx);
    const action = detail.actions?.find((candidate) => candidate.id === actionId);
    if (action) declared = (action.params ?? []).map((param) => param.name);
  } catch {
    return params;
  }
  if (declared === null) return params;
  for (const key of Object.keys(params)) {
    if (!declared.includes(key)) throw new StoreError(400, '动作参数无效');
  }
  return params;
}

/** 保留键（路由/动作标识 + JSON 参数袋），不参与动作参数。 */
const ACTION_RESERVED_KEYS = new Set(['id', 'actionId', 'params']);
/** 动作参数名：字母开头，允许字母/数字/下划线/连字符，最长 64。 */
const ACTION_PARAM_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * 从动作请求体收集参数：仅接受合法参数名的标量，忽略空值与保留键。
 *
 * 参数会原样透传给履约提供方（乃至上游），因此必须与动作声明对齐、且不得携带
 * 保留字段名——否则调用方可借参数覆盖上游的动作/鉴权字段（如 `func`/`action`）。
 * 平台 action 的 `input` 是静态声明，故另提供可选 `params`（JSON 对象字符串）作为
 * 通用参数袋，供动作声明了 `os`/`password` 之外的参数时使用；显式字段优先于 JSON。
 */
function collectActionParams(body: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  // 通用参数袋（可选 JSON 对象）。
  const bag = body['params'];
  if (bag !== undefined && bag !== null && bag !== '') {
    if (typeof bag !== 'string') throw new StoreError(400, '动作参数无效');
    let parsed: unknown;
    try {
      parsed = JSON.parse(bag);
    } catch {
      throw new StoreError(400, '动作参数无效');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StoreError(400, '动作参数无效');
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isScalar(value)) throw new StoreError(400, '动作参数无效');
      if (!ACTION_PARAM_NAME.test(key)) throw new StoreError(400, '动作参数无效');
      out[key] = String(value);
    }
  }
  for (const [key, value] of Object.entries(body)) {
    if (ACTION_RESERVED_KEYS.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    if (!isScalar(value)) throw new StoreError(400, '动作参数无效');
    if (!ACTION_PARAM_NAME.test(key)) throw new StoreError(400, '动作参数无效');
    out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/* ------------------------- 管理端：履约任务/服务 ------------------------- */

export async function listAdminDeliveryTasks(req: HttpRequest): Promise<unknown> {
  const query = z.object({ status: z.string().optional(), orderId: z.string().optional(), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const { status, orderId, page } = query;
  const { items, total } = await listTasksPage(page, 50, {
    ...(status ? { status } : {}),
    ...(orderId ? { orderId } : {}),
  });
  // Return only review data, never snapshots/configuration or provider errors containing secrets.
  return { tasks: await Promise.all(items.map(async task => {
    const service = await getService(task.serviceId ?? `instance-${task.id}`);
    const runtime = service?.runtime as { invoiceId?: string; paymentState?: string } | null;
    // 自动重试是有界的（`retryUnconfirmedProvisioning` 到 maxAttempts 就停手）。用尽
    // 之后订单不会自己往前走，既不重试也不退款 —— 如果不显式标出来，付了钱没拿到
    // 机器的单就永远躺在「待核对」里没人知道（真实案例：上游购物车锁竞争，3 次用尽）。
    const retryExhausted = task.status === 'REQUIRES_RECONCILIATION' && task.attempts >= task.maxAttempts;
    return {
    id: task.id, orderId: task.orderId, userId: task.userId, productName: task.productName,
    productId: task.productId, quantity: task.quantity, status: task.status,
    attempts: task.attempts, maxAttempts: task.maxAttempts, retryExhausted, createdAt: task.createdAt,
    upstreamServiceId: service?.providerServiceId ?? null,
    invoiceId: runtime?.invoiceId ?? null, paymentState: runtime?.paymentState ?? null,
    canResumePayment: service?.status === 'AWAITING_UPSTREAM_PAYMENT' && Boolean(service.providerServiceId && runtime?.invoiceId && ['ORDER_CREATED', 'PAYMENT_REQUIRED'].includes(runtime.paymentState ?? '')),
    reason: task.status !== 'REQUIRES_RECONCILIATION' ? null
      : retryExhausted
        ? '自动重试已用尽，需人工核对上游：确认无实例请在订单页退款'
        : '开通请求结果未确认，请核对上游实例后处理',
  }; })), total, page, pageSize: 50 };
}

export async function resumeAdminDeliveryPayment(req: HttpRequest): Promise<unknown> {
  z.object({ confirmed: z.literal(true) }).strict().parse(req.body);
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少任务 ID');
  await runTransaction(async tx => {
    const task = await tx.extensions.get<StoreDeliveryTaskData>(deliveryTaskModel, id);
    if (!task || task.spec.state !== 'REQUIRES_RECONCILIATION') throw new StoreError(409, '任务不在待核对状态');
    const paid = await tx.extensions.updateWhere(orderModel, { name: { eq: task.spec.orderId }, state: { eq: 'PAID' } }, { state: { set: 'PAID' } });
    if (paid.updated !== 1) throw new StoreError(409, '订单未付款或已退款');
    const service = await tx.extensions.get<StoreServiceInstanceData>(serviceInstanceModel, task.spec.serviceId ?? `instance-${id}`);
    const runtime = service?.spec.runtime as { invoiceId?: string; paymentState?: string } | null;
    if (!service || service.spec.orderId !== task.spec.orderId || service.spec.userId !== task.spec.userId || service.spec.state !== 'AWAITING_UPSTREAM_PAYMENT' || !service.spec.providerServiceId || !runtime?.invoiceId || !['ORDER_CREATED', 'PAYMENT_REQUIRED'].includes(runtime.paymentState ?? '')) throw new StoreError(409, '原账单不存在、已付款或付款结果未知，禁止重试');
    await tx.extensions.update(deliveryTaskModel, id, {
      ...task.spec, state: 'PENDING', nextAttemptAtMs: 0,
      payload: { ...((task.spec.payload as Record<string, unknown>) ?? {}), resumePayment: true },
    }, { expectedVersion: task.version });
  });
  await recordStoreAudit({ action: 'store.provision.resume-payment', resource: 'store.delivery-task', resourceId: id, ...auditActor(req) });
  return { queued: true };
}

/** Verification queues a new manual review; it never creates or pays an upstream order. */
export async function recoverAdminDeliveryTask(req: HttpRequest): Promise<unknown> {
  z.object({ confirmed: z.literal(true) }).strict().parse(req.body);
  const id = req.params['id'];
  const task = id ? await context().extensions.get<StoreDeliveryTaskData>(deliveryTaskModel, id) : null;
  if (!task || task.spec.state !== 'REQUIRES_RECONCILIATION' || task.spec.quantity !== 1)
    throw new StoreError(409, '仅单台待核对任务可以申请重开');
  const verifiedTaskVersion = task.version;
  const product = await getProduct(task.spec.productId);
  if (!product) throw new StoreError(409, '商品不存在');
  const snapshot = task.spec.payload as TaskProductSnapshot & { recoveryGeneration?: number };
  if (!snapshot || product.providerId !== task.spec.providerId || product.providerProductId !== snapshot.providerProductId || JSON.stringify(product.metadata) !== JSON.stringify(snapshot.metadata))
    throw new StoreError(409, '商品上游配置已变更，请先核对原订单');
  const generation = (snapshot.recoveryGeneration ?? 0) + 1;
  const provider = providerForProduct(product);
  if (!provider?.verifyCancelledProvision) throw new StoreError(409, '提供方不支持原账单取消核验');
  const evidence = await provider.verifyCancelledProvision({
    fulfillmentId: id!, recoveryGeneration: generation,
    orderId: task.spec.orderId, productId: task.spec.productId, userId: task.spec.userId,
    quantity: 1, product, ...(snapshot.config ? { config: snapshot.config as CheckoutSelection } : {}), secrets: context().secrets,
  });
  if (!evidence.requests.length || evidence.requests.length !== generation || !Number.isFinite(Date.parse(evidence.checkedAt)) || Math.abs(Date.now() - Date.parse(evidence.checkedAt)) > 60_000)
    throw new StoreError(409, '原请求核验证据不完整或已过期');
  await runTransaction(async tx => {
    const paid = await tx.extensions.updateWhere(orderModel, { name: { eq: task.spec.orderId }, state: { eq: 'PAID' } }, { state: { set: 'PAID' } });
    if (paid.updated !== 1) throw new StoreError(409, '仅已付款且未退款订单可以重新申请');
    const current = await tx.extensions.get<StoreDeliveryTaskData>(deliveryTaskModel, id!);
    if (!current || current.version !== verifiedTaskVersion || current.spec.state !== 'REQUIRES_RECONCILIATION') throw new StoreError(409, '任务已变更，请重新核验');
    const serviceId = current.spec.serviceId ?? `instance-${id}`;
    const service = await tx.extensions.get<StoreServiceInstanceData>(serviceInstanceModel, serviceId);
    if (!service || service.spec.orderId !== task.spec.orderId || service.spec.userId !== task.spec.userId) throw new StoreError(409, '实例归属已变更');
    await tx.extensions.update(serviceInstanceModel, serviceId, {
      ...service.spec, providerServiceId: null, credentialsRef: null, state: 'AWAITING_APPROVAL',
      provisionedAt: null, expiresAt: null, expiresAtMs: null,
      runtime: { config: snapshot.config ?? null, previousProvision: service.spec.runtime, recoveryGeneration: generation },
    }, { expectedVersion: service.version });
    await tx.extensions.update(deliveryTaskModel, id!, {
      ...current.spec, state: 'AWAITING_APPROVAL', error: null, nextAttemptAtMs: 0,
      payload: { ...snapshot, resumePayment: false, recoveryGeneration: generation, recoveryEvidence: evidence },
    }, { expectedVersion: current.version });
  });
  await recordStoreAudit({ action: 'store.provision.recovery-requested', resource: 'store.delivery-task', resourceId: id!, ...auditActor(req), meta: { generation, checkedAt: evidence.checkedAt, sourceId: evidence.sourceId } });
  return { awaitingApproval: true, generation };
}

/** Human reconciliation never provisions. An absent result goes back through approval. */
export async function listAdminReconciliationCandidates(req: HttpRequest): Promise<unknown> {
  const task = req.params['id'] ? await getTask(req.params['id']) : null;
  if (!task) throw new StoreError(404, '任务不存在');
  const source = (task.payload as { metadata?: { upstream?: { sourceRef?: string } } } | null)?.metadata?.upstream?.sourceRef;
  return { services: (await listServicesByUser(task.userId)).filter(service =>
    service.providerServiceId && !service.orderId && service.productId === task.productId && service.providerId === task.providerId &&
    ['ACTIVE', 'SUSPENDED', 'PROVISIONING'].includes(service.status) &&
    (!source || (service.runtime as { upstreamId?: string } | null)?.upstreamId === source),
  ).map(service => ({ id: service.id, productName: service.productName, providerServiceId: service.providerServiceId, status: service.status })) };
}

export async function reconcileAdminDeliveryTask(req: HttpRequest): Promise<unknown> {
  const body = z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('not_created'), confirmed: z.literal(true), note: z.string().trim().min(5).max(500) }).strict(),
    z.object({ outcome: z.literal('existing'), serviceId: z.string().min(1), confirmed: z.literal(true), note: z.string().trim().min(5).max(500) }).strict(),
  ]).parse(req.body);
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少任务 ID');
  await runTransaction(async tx => {
    const task = await tx.extensions.get<StoreDeliveryTaskData>(deliveryTaskModel, id);
    if (!task || !['REQUIRES_RECONCILIATION', 'FAILED'].includes(task.spec.state)) throw new StoreError(409, '任务不在待核对状态');
    if (body.outcome === 'not_created' && task.spec.attempts > 0) throw new StoreError(409, '请求已执行过，不能通过人工声明重新下单；请核对并关联原上游订单');
    // Same order lock as claim/refund: a refunded order cannot be recovered.
    const paid = await tx.extensions.updateWhere(orderModel, { name: { eq: task.spec.orderId }, state: { eq: 'PAID' } }, { state: { set: 'PAID' } });
    if (paid.updated !== 1) throw new StoreError(409, '仅已付款订单可处理开通');
    const placeholder = await tx.extensions.get<StoreServiceInstanceData>(serviceInstanceModel, `instance-${id}`);
    if (!placeholder || placeholder.spec.providerServiceId || placeholder.spec.userId !== task.spec.userId || placeholder.spec.orderId !== task.spec.orderId) throw new StoreError(409, '实例关联已变更，请重新核对');
    const runtime = { ...((placeholder.spec.runtime as Record<string, unknown>) ?? {}), provisioningReviewRequired: false };
    let serviceSpec: StoreServiceInstanceData = { ...placeholder.spec, state: 'AWAITING_APPROVAL', runtime };
    if (body.outcome === 'existing') {
      // Only an already imported/verified resource belonging to this user and product can be used.
      const bound = await tx.extensions.get<StoreServiceInstanceData>(serviceInstanceModel, body.serviceId);
      if (!bound || !bound.spec.providerServiceId || bound.spec.orderId || bound.spec.userId !== task.spec.userId || bound.spec.productId !== task.spec.productId || bound.spec.providerId !== task.spec.providerId || !['ACTIVE', 'SUSPENDED', 'PROVISIONING'].includes(bound.spec.state)) throw new StoreError(409, '请选择已绑定到该用户、同一商品且未关联订单的上游实例');
      const sourceRef = (task.spec.payload as { metadata?: { upstream?: { sourceRef?: string } } } | null)?.metadata?.upstream?.sourceRef;
      const importedSource = (bound.spec.runtime as { upstreamId?: string } | null)?.upstreamId;
      if (sourceRef && sourceRef !== importedSource) throw new StoreError(409, '上游来源不一致，禁止关联');
      serviceSpec = { ...bound.spec, orderId: task.spec.orderId, amount: placeholder.spec.amount, currency: placeholder.spec.currency, runtime: { ...runtime, ...((bound.spec.runtime as Record<string, unknown>) ?? {}), provisioningReviewRequired: false } };
      // Preserve the order's canonical service URL. Retire the imported duplicate atomically.
      await tx.extensions.update(serviceInstanceModel, body.serviceId, bound.spec, { expectedVersion: bound.version });
      await tx.extensions.delete(serviceInstanceModel, body.serviceId);
    }
    await tx.extensions.update(serviceInstanceModel, placeholder.name, serviceSpec, { expectedVersion: placeholder.version });
    await tx.extensions.update(deliveryTaskModel, id, {
      ...task.spec, state: body.outcome === 'existing' ? 'SUCCEEDED' : 'AWAITING_APPROVAL',
      serviceId: body.outcome === 'existing' ? placeholder.name : null, error: null, nextAttemptAtMs: 0,
      payload: { ...((task.spec.payload as Record<string, unknown>) ?? {}), reconciliation: { outcome: body.outcome, note: body.note, actorId: req.user?.id, at: new Date().toISOString() } },
    }, { expectedVersion: task.version });
  });
  await recordStoreAudit({ action: 'store.provision.reconciled', resource: 'store.delivery-task', resourceId: id, ...auditActor(req), meta: { outcome: body.outcome, note: body.note } });
  return { reconciled: true };
}

export async function listAdminServices(req: HttpRequest): Promise<unknown> {
  const { status } = req.query as { status?: string };
  const { items } = await listServicesPage(1, 100, status);
  return { services: items };
}

export async function retryAdminDeliveryTask(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const task = await getTask(id);
  if (task?.serviceId || (await getService(`instance-${id}`)))
    throw new StoreError(409, '已存在实例记录，请先核对上游结果，禁止盲目重新开通');
  const updated = await retryFailedTask(id, Date.now());
  if (!updated) throw new StoreError(409, '任务不存在或不可重试');
  void processDue().catch(() => undefined);
  return { retried: true };
}

export async function approveAdminDeliveryTask(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  const task = id ? await getTask(id) : null;
  if (!task) throw new StoreError(404, '任务不存在');
  const order = await getOrder(task.orderId);
  if (!order || order.status !== 'PAID') throw new StoreError(409, '仅已付款订单可以审核开通');
  if (!(await approveDeliveryTask(task.id)))
    throw new StoreError(409, '任务已审核或不在待审核状态');
  await recordStoreAudit({
    action: 'store.provision.approved',
    resource: 'store/delivery-task',
    resourceId: task.id,
    ...auditActor(req),
    meta: { orderId: task.orderId },
  });
  return { approved: true };
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}

/** 在 order.paid 时触发履约。由 store 激活时订阅。 */
export function subscribeOrderPaid(): () => void {
  return bus().subscribe('order.paid', (payload, meta) => {
    const orderId = (payload as { orderId?: string } | null)?.orderId;
    if (!orderId) return;
    const enqueue = () => enqueueOrderFulfillment(orderId);
    // `order.paid` 是 at-least-once（relay 崩溃重投 + 副本离线后 catch-up 补齐）。
    // 入队本身已按 (orderId, productId) 去重，这里再按 eventId 去重，避免同一事件
    // 重复执行整个扫描（以及重放导致的额外日志/DB 读）。
    const busRef = bus();
    const run =
      meta?.eventId && typeof busRef.runIdempotent === 'function'
        ? busRef.runIdempotent(`store.fulfillment`, meta.eventId, enqueue)
        : enqueue();
    void Promise.resolve(run).catch((error) => {
      logger().error(`store: enqueue fulfillment failed for ${orderId}: ${messageOf(error)}`);
    });
  });
}
