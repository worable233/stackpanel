import type {
  CheckoutSelection,
  FulfillmentProvider,
  HttpRequest,
  MetricSeries,
  ProvisionContext,
  ProviderServiceContext,
  ServiceDetail,
} from '@stackpanel/sdk';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import { bus, context, logger } from './context';
import { StoreError } from './errors';
import { stockItems } from './errors';
import { productTypeById } from './product-types';
import {
  claimTask,
  createServiceInstance,
  createTaskInstance,
  getOrder,
  getProduct,
  getService,
  getTask,
  listDueTasks,
  listServicesByUser,
  listServicesPage,
  listTasksPage,
  replaceServiceInstance,
  replaceTask,
  retryFailedTask,
  type DeliveryTaskRecord,
  type ServiceInstanceRecord,
} from './repository';
import type { StoreDeliveryTaskData, StoreServiceInstanceData } from './data';

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

const isoOrNull = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/**
 * 为已支付订单的每一行创建异步履约任务，并立即触发一轮处理。
 * 由 `order.paid` 事件驱动（钱包即时支付与外部结算回调都会发布该事件）。
 */
export async function enqueueOrderFulfillment(orderId: string): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) return;
  for (const line of stockItems(order)) {
    const product = await getProduct(line.productId);
    if (!product) continue;
    const snapshot: TaskProductSnapshot = {
      name: product.name,
      price: product.price,
      currency: product.currency,
      metadata: product.metadata,
      providerProductId: product.providerProductId,
      ...(line.config !== undefined && line.config !== null ? { config: line.config } : {}),
    };
    await createTaskInstance({
      orderId: order.id,
      productId: product.id,
      userId: order.userId,
      productName: product.name,
      fulfillmentType: product.fulfillmentType,
      providerId: product.providerId,
      quantity: line.quantity,
      state: 'PENDING',
      attempts: 0,
      maxAttempts: 3,
      error: null,
      payload: snapshot,
      serviceId: null,
      nextAttemptAtMs: 0,
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
  const due = await listDueTasks(nowMs, 20);
  for (const task of due) {
    const claimed = await claimTask(task.id);
    if (!claimed) continue;
    await runTask(task.id);
  }
}

async function runTask(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  const product = await getProduct(task.productId);
  const provider = product ? providerForProduct(product) : null;

  if (!product || !provider) {
    await markTaskFailed(taskId, '未找到对应的履约提供方');
    return;
  }

  const snapshot = (task.payload ?? {}) as Partial<TaskProductSnapshot>;
  const provisionCtx: ProvisionContext = {
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
    ...(snapshot.config !== undefined && snapshot.config !== null
      ? { config: snapshot.config as CheckoutSelection }
      : {}),
    secrets: context().secrets,
  };

  try {
    const result = await provider.provision(provisionCtx);
    const service = await createServiceInstance({
      userId: task.userId,
      orderId: task.orderId,
      productId: task.productId,
      productName: task.productName,
      fulfillmentType: task.fulfillmentType,
      providerId: product.providerId,
      providerServiceId: result.providerServiceId ?? null,
      state:
        result.status === 'ACTIVE'
          ? 'ACTIVE'
          : result.status === 'PENDING'
            ? 'PROVISIONING'
            : 'FAILED',
      credentialsRef: null,
      runtime: result.runtime ?? null,
      amount: snapshot.price ?? product.price,
      currency: snapshot.currency ?? product.currency,
      provisionedAt: result.status === 'ACTIVE' ? new Date().toISOString() : null,
    });

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
      state: 'SUCCEEDED',
      serviceId: service.id,
      error: null,
    });
  } catch (error) {
    const message = messageOf(error);
    if (task.attempts >= task.maxAttempts) {
      await markTaskFailed(taskId, message);
      await createServiceInstance({
        userId: task.userId,
        orderId: task.orderId,
        productId: task.productId,
        productName: task.productName,
        fulfillmentType: task.fulfillmentType,
        providerId: product.providerId,
        providerServiceId: null,
        state: 'FAILED',
        credentialsRef: null,
        runtime: { error: message },
        amount: snapshot.price ?? product.price,
        currency: snapshot.currency ?? product.currency,
        provisionedAt: null,
      }).catch(() => undefined);
    } else {
      const backoff = Date.now() + Math.min(task.attempts, 6) * 30_000;
      await replaceTask(taskId, {
        ...toTaskData(task),
        state: 'PENDING',
        error: message,
        nextAttemptAtMs: backoff,
      });
    }
  }
}

async function markTaskFailed(taskId: string, message: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  await replaceTask(taskId, { ...toTaskData(task), state: 'FAILED', error: message });
}

const toServiceData = (service: ServiceInstanceRecord): StoreServiceInstanceData => ({
  userId: service.userId,
  orderId: service.orderId,
  productId: service.productId,
  productName: service.productName,
  fulfillmentType: service.fulfillmentType,
  providerId: service.providerId,
  providerServiceId: service.providerServiceId,
  state: service.status,
  credentialsRef: service.credentialsRef,
  runtime: service.runtime,
  amount: service.amount,
  currency: service.currency,
  expiresAt: isoOrNull(service.expiresAt),
  provisionedAt: isoOrNull(service.provisionedAt),
  terminatedAt: isoOrNull(service.terminatedAt),
});

const toTaskData = (task: DeliveryTaskRecord): StoreDeliveryTaskData => ({
  orderId: task.orderId,
  productId: task.productId,
  userId: task.userId,
  productName: task.productName,
  fulfillmentType: task.fulfillmentType,
  providerId: task.providerId,
  quantity: task.quantity,
  state: task.status,
  attempts: task.attempts,
  maxAttempts: task.maxAttempts,
  error: task.error,
  payload: task.payload,
  serviceId: task.serviceId,
  nextAttemptAtMs: task.nextAttemptAt ? task.nextAttemptAt.getTime() : 0,
});

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
    },
    secrets: context().secrets,
  };
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

export async function listMyServices(req: HttpRequest): Promise<unknown> {
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const services = await listServicesByUser(userId);
  return {
    services: services.map((service) => ({
      id: service.id,
      productName: service.productName,
      fulfillmentType: service.fulfillmentType,
      status: service.status,
      runtime: service.runtime,
      amount: service.amount,
      currency: service.currency,
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
  if (provider?.getDetail) {
    detail = await provider.getDetail(serviceContext(service));
  }
  return {
    service: {
      id: service.id,
      productName: service.productName,
      fulfillmentType: service.fulfillmentType,
      providerId: service.providerId,
      providerServiceId: service.providerServiceId,
      status: detail?.status ?? service.status,
      statusLabel: detail?.statusLabel ?? null,
      title: detail?.title ?? service.productName,
      runtime: service.runtime,
      amount: service.amount,
      currency: service.currency,
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
  const provider = providerById(service.providerId) ?? productTypeById(service.fulfillmentType);
  if (!provider?.executeAction) throw new StoreError(501, '该服务不支持此操作');
  const actionId = (req.body as { actionId?: string })?.actionId;
  if (!actionId) throw new StoreError(400, '缺少动作 ID');
  await provider.executeAction(actionId, serviceContext(service));
  return { ok: true };
}

/* ------------------------- 管理端：履约任务/服务 ------------------------- */

export async function listAdminDeliveryTasks(req: HttpRequest): Promise<unknown> {
  const { status, orderId } = req.query as { status?: string; orderId?: string };
  const { items } = await listTasksPage(1, 100, {
    ...(status ? { status } : {}),
    ...(orderId ? { orderId } : {}),
  });
  return { tasks: items };
}

export async function listAdminServices(req: HttpRequest): Promise<unknown> {
  const { status } = req.query as { status?: string };
  const { items } = await listServicesPage(1, 100, status);
  return { services: items };
}

export async function retryAdminDeliveryTask(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const updated = await retryFailedTask(id, Date.now());
  if (!updated) throw new StoreError(409, '任务不存在或不可重试');
  void processDue().catch(() => undefined);
  return { retried: true };
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}

/** 在 order.paid 时触发履约。由 store 激活时订阅。 */
export function subscribeOrderPaid(): () => void {
  return bus().subscribe('order.paid', (payload) => {
    const orderId = (payload as { orderId?: string } | null)?.orderId;
    if (!orderId) return;
    void enqueueOrderFulfillment(orderId).catch((error) => {
      logger().error(`store: enqueue fulfillment failed for ${orderId}: ${messageOf(error)}`);
    });
  });
}
