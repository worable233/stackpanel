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
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import { bus, context, logger } from './context';
import { notifyAdmins, notifyUser } from './notifications';
import { StoreError } from './errors';
import { stockItems } from './errors';
import { productTypeById } from './product-types';
import { initialExpiryAt } from './utils';
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
  if (!order) return;
  // 续费行不产生交付任务（服务已存在），改由 renewal 模块顺延到期时间。
  const { applyRenewalOrder } = await import('./renewal');
  const { applyChangeOrder } = await import('./changes');
  // 入队幂等：`order.paid` 是 at-least-once（重放回调、结算重试都会再次触发），
  // 同一 (orderId, productId) 只能有一个履约任务，否则会重复开通。
  const existing = await listTasksByOrder(orderId);
  const seen = new Set(existing.map((task) => task.productId));
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
      await reclaimTask(task.id, nowMs, task.attempts < task.maxAttempts);
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
  if (!task) return;
  const product = await getProduct(task.productId);
  const provider = product ? providerForProduct(product) : null;

  if (!product || !provider) {
    await markTaskFailed(taskId, '未找到对应的履约提供方');
    return;
  }

  const snapshot = (task.payload ?? {}) as Partial<TaskProductSnapshot>;
  const selection = (snapshot.config ?? null) as CheckoutSelection | null;
  // 周期商品的初始到期时间由 store 统一推算（唯一一套周期算法），先算后传给
  // 提供方，避免提供方自己再算一遍导致权益到期时间与商店展示不一致。
  const initialExpiry = initialExpiryAt(product.metadata, selection?.cycle, new Date());
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
    ...(selection ? { config: selection } : {}),
    expiresAt: initialExpiry ? initialExpiry.toISOString() : null,
    secrets: context().secrets,
  };

  try {
    const result = await provider.provision(provisionCtx);
    // 周期商品按结账周期落一个初始到期时间（缺省取第一个周期）；永久商品为 null。
    // 异步开通（PENDING）也在下单时起算，避免上游开通后无到期时间。
    const serviceExpiry = result.status !== 'FAILED' ? initialExpiry : null;
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
      runtime: mergeRuntime(result.runtime, provisionCtx.config),
      amount: snapshot.price ?? product.price,
      currency: snapshot.currency ?? product.currency,
      ...(serviceExpiry ? { expiresAt: serviceExpiry.toISOString() } : {}),
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
      // 最终开通失败：通知用户并同步告知授权管理员（审计 §5）。
      await notifyUser({
        userId: task.userId,
        type: 'service.provision.failed',
        title: '服务开通失败',
        body: `「${task.productName}」开通失败：${message}。已通知管理员处理。`,
        link: `/account/orders`,
        data: { orderId: task.orderId, productId: task.productId, error: message },
        status: 'error',
        dedupeKey: `store:provision:${task.orderId}:${task.productId}`,
      });
      await notifyAdmins({
        type: 'admin.service.provision.failed',
        title: '订单开通失败',
        body: `订单 ${task.orderId} 的「${task.productName}」开通失败：${message}，需人工介入。`,
        link: `/admin/store/orders`,
        data: { orderId: task.orderId, productId: task.productId, userId: task.userId },
      });
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

const toServiceData = toServiceInstanceData;

/** 把结账配置选择并入 runtime（供升配/续费/详情复用）。 */
function mergeRuntime(
  runtime: Record<string, unknown> | undefined,
  config: CheckoutSelection | undefined,
): Record<string, unknown> | null {
  const base = runtime && typeof runtime === 'object' ? runtime : {};
  if (!config || (!config.cycle && !config.selections)) {
    return Object.keys(base).length > 0 ? base : null;
  }
  return { ...base, config };
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
  if (provider?.getDetail) {
    detail = await provider.getDetail(serviceContext(service));
  }
  return {
    service: {
      id: service.id,
      productId: service.productId,
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
async function requireOwnedServiceById(req: HttpRequest): Promise<{ service: ServiceInstanceRecord }> {
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const service = await getService(id);
  if (!service) throw new StoreError(404, '服务不存在');
  requireOwnedService(service, userId);
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
  change: { type: 'package' | 'product'; config?: CheckoutSelection; targetProductId?: string; targetProviderProductId?: string | null },
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
