import type { ExtensionInstance } from '@stackpanel/sdk';
import { isExtensionVersionConflict } from '@stackpanel/sdk';
import { extensions, runTransaction } from './context.js';
import {
  cartItemModel,
  categoryModel,
  deliveryTaskModel,
  orderModel,
  productModel,
  serviceInstanceModel,
  type StoreCartItemData,
  type StoreCategoryData,
  type StoreDeliveryTaskData,
  type StoreOrderData,
  type StoreProductData,
  type StoreServiceInstanceData,
} from './data.js';

/**
 * Extension 实例与插件领域对象之间的适配层。
 *
 * 引擎实例只有 `name`/`spec`/元数据；领域代码沿用迁移前的字段形状（`id`、
 * `status`、时间等），转换集中在此，模块不再直接拼实例结构。生命周期状态在
 * 载荷里叫 `state`（见 data.ts），对外统一暴露成 `status`。
 */

export interface ProductRecord extends StoreProductData {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoryRecord extends StoreCategoryData {
  id: string;
}

export interface CartItemRecord extends StoreCartItemData {
  id: string;
  createdAt: Date;
}

export interface OrderRecord {
  id: string;
  userId: string;
  items: unknown;
  total: number;
  currency: string;
  status: string;
  channelCode: string | null;
  settlementCurrency: string;
  settlementTotal: number;
  fxRate: number | null;
  /** 回收站时间；`null` 表示未进回收站。 */
  deletedAt: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceInstanceRecord {
  id: string;
  userId: string;
  orderId: string | null;
  productId: string;
  productName: string;
  fulfillmentType: string;
  providerId: string | null;
  providerServiceId: string | null;
  status: string;
  credentialsRef: string | null;
  runtime: unknown;
  amount: number;
  currency: string;
  expiresAt: Date | null;
  /** epoch 毫秒镜像（索引列，供范围扫描）。 */
  expiresAtMs: number | null;
  /** 到期处理阶段：reminded | suspending | suspended | terminating | terminated。 */
  expiryStage: string | null;
  /** 到期动作（暂停/终止）的上游调用尝试次数；成功落终态时清 0。 */
  expiryAttempts: number;
  /** 到期动作最后一次上游失败原因；成功落终态时清 null。 */
  expiryLastError: string | null;
  provisionedAt: Date | null;
  terminatedAt: Date | null;
  createdAt: Date;
}

export interface DeliveryTaskRecord {
  id: string;
  orderId: string;
  productId: string;
  userId: string;
  productName: string;
  fulfillmentType: string;
  providerId: string | null;
  quantity: number;
  status: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  payload: unknown;
  serviceId: string | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const parseDate = (value: string | null): Date | null => (value ? new Date(value) : null);
const isoOrNull = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

export function toProduct(instance: ExtensionInstance<StoreProductData>): ProductRecord {
  return {
    id: instance.name,
    ...instance.spec,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

export function toCategory(instance: ExtensionInstance<StoreCategoryData>): CategoryRecord {
  return { id: instance.name, ...instance.spec };
}

export function toCartItem(instance: ExtensionInstance<StoreCartItemData>): CartItemRecord {
  return { id: instance.name, ...instance.spec, createdAt: instance.createdAt };
}

export function toOrder(instance: ExtensionInstance<StoreOrderData>): OrderRecord {
  // `deletedAtMs` 是实现细节（索引用的数值镜像），不外暴露给接口调用方。
  const { state, deletedAt, deletedAtMs: _deletedAtMs, ...rest } = instance.spec;
  return {
    id: instance.name,
    ...rest,
    status: state,
    // 存量行没有这个键（列是后来加的），统一归一为 null。
    deletedAt: deletedAt ?? null,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

export function toService(instance: ExtensionInstance<StoreServiceInstanceData>): ServiceInstanceRecord {
  const {
    state,
    expiresAt,
    expiresAtMs,
    expiryStage,
    expiryAttempts,
    expiryLastError,
    provisionedAt,
    terminatedAt,
    ...rest
  } = instance.spec;
  return {
    id: instance.name,
    ...rest,
    status: state,
    expiresAt: parseDate(expiresAt),
    expiresAtMs: expiresAtMs ?? null,
    expiryStage: expiryStage ?? null,
    expiryAttempts: expiryAttempts ?? 0,
    expiryLastError: expiryLastError ?? null,
    provisionedAt: parseDate(provisionedAt),
    terminatedAt: parseDate(terminatedAt),
    createdAt: instance.createdAt,
  };
}

/** 领域记录 → 载荷（唯一规范来源，供 create/replace/续费共用）。 */
export function toServiceInstanceData(service: ServiceInstanceRecord): StoreServiceInstanceData {
  return {
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
    expiresAtMs: service.expiresAtMs ?? toEpochMs(isoOrNull(service.expiresAt)),
    expiryStage: service.expiryStage,
    expiryAttempts: service.expiryAttempts,
    expiryLastError: service.expiryLastError,
    provisionedAt: isoOrNull(service.provisionedAt),
    terminatedAt: isoOrNull(service.terminatedAt),
  };
}

export function toTask(instance: ExtensionInstance<StoreDeliveryTaskData>): DeliveryTaskRecord {
  const { state, nextAttemptAtMs, ...rest } = instance.spec;
  return {
    id: instance.name,
    ...rest,
    status: state,
    nextAttemptAt: nextAttemptAtMs > 0 ? new Date(nextAttemptAtMs) : null,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

/** 领域任务记录 → 存储载荷（`replaceTask`/`reclaimTask` 整行回写共用）。 */
export function toTaskData(task: DeliveryTaskRecord): StoreDeliveryTaskData {
  return {
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
  };
}

/* ----------------------------- 商品 ----------------------------- */

export async function getProduct(id: string): Promise<ProductRecord | null> {
  const instance = await extensions().get<StoreProductData>(productModel, id);
  return instance ? toProduct(instance) : null;
}

export async function listAllProducts(): Promise<ProductRecord[]> {
  const rows = await extensions().listAll<StoreProductData>(productModel, {
    orderBy: { field: 'createdAt', desc: true },
  });
  return rows.map(toProduct);
}

export async function listProductsByIds(ids: string[]): Promise<ProductRecord[]> {
  if (ids.length === 0) return [];
  const rows = await extensions().listAll<StoreProductData>(productModel, {
    where: { name: { in: ids } },
    orderBy: { field: 'createdAt', desc: true },
  });
  return rows.map(toProduct);
}

export async function listActiveProductsPage(
  page: number,
  pageSize: number,
  categoryId?: string,
  query?: string,
): Promise<{ items: ProductRecord[]; total: number }> {
  const result = await extensions().list<StoreProductData>(productModel, {
    where: {
      status: { eq: 'ACTIVE' },
      ...(categoryId ? { categoryId: { eq: categoryId } } : {}),
      ...(query ? { name: { contains: query } } : {}),
    },
    orderBy: { field: 'createdAt', desc: true },
    page,
    pageSize,
  });
  return { items: result.items.map(toProduct), total: result.total };
}

export async function listAllProductsPage(
  page: number,
  pageSize: number,
): Promise<{ items: ProductRecord[]; total: number }> {
  const result = await extensions().list<StoreProductData>(productModel, {
    orderBy: { field: 'createdAt', desc: true },
    page,
    pageSize,
  });
  return { items: result.items.map(toProduct), total: result.total };
}

export async function createProductInstance(
  data: StoreProductData,
  name?: string,
): Promise<ProductRecord> {
  const created = await extensions().create<StoreProductData>(
    productModel,
    data,
    name ? { name } : undefined,
  );
  return toProduct(created);
}

export async function replaceProduct(id: string, data: StoreProductData): Promise<ProductRecord> {
  const updated = await extensions().update<StoreProductData>(productModel, id, data);
  return toProduct(updated);
}

export async function deleteProductInstance(id: string): Promise<void> {
  await extensions().delete(productModel, id);
}

/** 原子预留库存：仅当仍 ACTIVE 且库存足够时自减，返回是否成功。 */
export async function reserveProductStock(productId: string, quantity: number): Promise<boolean> {
  const { updated } = await extensions().updateWhere(
    productModel,
    {
      name: { eq: productId },
      status: { eq: 'ACTIVE' },
      stock: { gte: quantity },
    },
    { stock: { dec: quantity } },
  );
  return updated > 0;
}

/** 归还库存（取消/释放订单）。 */
export async function releaseProductStock(productId: string, quantity: number): Promise<void> {
  await extensions().updateWhere(productModel, { name: { eq: productId } }, { stock: { inc: quantity } });
}

/** 后台/上游同步直接设定库存。 */
export async function setProductStock(productId: string, stock: number): Promise<boolean> {
  const { updated } = await extensions().updateWhere(
    productModel,
    { name: { eq: productId } },
    { stock: { set: stock } },
  );
  return updated > 0;
}

/* ----------------------------- 分类 ----------------------------- */

export async function listEnabledCategories(): Promise<CategoryRecord[]> {
  const rows = await extensions().listAll<StoreCategoryData>(categoryModel, {
    where: { enabled: { eq: true } },
    orderBy: { field: 'sortOrder', desc: false },
  });
  return rows.map(toCategory);
}

export async function createCategoryInstance(
  data: StoreCategoryData,
): Promise<CategoryRecord> {
  const created = await extensions().create<StoreCategoryData>(categoryModel, data);
  return toCategory(created);
}

export async function replaceCategory(
  id: string,
  data: StoreCategoryData,
): Promise<CategoryRecord> {
  const updated = await extensions().update<StoreCategoryData>(categoryModel, id, data);
  return toCategory(updated);
}

export async function getCategory(id: string): Promise<CategoryRecord | null> {
  const instance = await extensions().get<StoreCategoryData>(categoryModel, id);
  return instance ? toCategory(instance) : null;
}

export async function deleteCategoryInstance(id: string): Promise<void> {
  await extensions().delete(categoryModel, id);
}

/* --------------------------- 购物车项 --------------------------- */

export async function listCartItemsByUser(userId: string): Promise<CartItemRecord[]> {
  const rows = await extensions().listAll<StoreCartItemData>(cartItemModel, {
    where: { userId: { eq: userId } },
    orderBy: { field: 'createdAt', desc: true },
  });
  return rows.map(toCartItem);
}

export async function listCartItemsByIds(
  userId: string,
  ids: string[],
): Promise<CartItemRecord[]> {
  if (ids.length === 0) return [];
  const rows = await extensions().listAll<StoreCartItemData>(cartItemModel, {
    where: { userId: { eq: userId }, name: { in: ids } },
  });
  return rows.map(toCartItem);
}

export async function getCartItem(id: string): Promise<CartItemRecord | null> {
  const instance = await extensions().get<StoreCartItemData>(cartItemModel, id);
  return instance ? toCartItem(instance) : null;
}

export async function createCartItem(data: StoreCartItemData): Promise<CartItemRecord> {
  const created = await extensions().create<StoreCartItemData>(cartItemModel, data);
  return toCartItem(created);
}

export async function replaceCartItem(
  id: string,
  data: StoreCartItemData,
): Promise<CartItemRecord> {
  const updated = await extensions().update<StoreCartItemData>(cartItemModel, id, data);
  return toCartItem(updated);
}

export async function deleteCartItems(ids: string[]): Promise<void> {
  for (const id of ids) {
    await extensions()
      .delete(cartItemModel, id)
      .catch(() => undefined);
  }
}

/* ----------------------------- 订单 ----------------------------- */

export async function getOrder(id: string): Promise<OrderRecord | null> {
  const instance = await extensions().get<StoreOrderData>(orderModel, id);
  return instance ? toOrder(instance) : null;
}

export async function findOrderForUser(id: string, userId: string): Promise<OrderRecord | null> {
  // 回收站里的订单对用户不可见（详情/取消/再次删除都当 404），也不得被
  // 交易路径当成“可用订单”改状态。
  const page = await extensions().list<StoreOrderData>(orderModel, {
    where: { name: { eq: id }, userId: { eq: userId }, deletedAt: { eq: null } },
    page: 1,
    pageSize: 1,
  });
  const instance = page.items[0];
  return instance ? toOrder(instance) : null;
}

export async function listOrdersForUserPage(
  userId: string,
  page: number,
  pageSize: number,
  options: { includeRecycled?: boolean } = {},
): Promise<{ items: OrderRecord[]; total: number }> {
  const result = await extensions().list<StoreOrderData>(orderModel, {
    where: {
      userId: { eq: userId },
      ...(options.includeRecycled ? {} : { deletedAt: { eq: null } }),
    },
    orderBy: { field: 'createdAt', desc: true },
    page,
    pageSize,
  });
  return { items: result.items.map(toOrder), total: result.total };
}

export async function listAllOrdersPage(
  page: number,
  pageSize: number,
  /**
   * 回收站筛选。`all`（默认）保持历史行为（含已回收），因为财务报表、
   * 币种审计这类调用必须看得到全部订单；后台列表按需传 `active` / `recycled`。
   */
  recycled: 'all' | 'active' | 'recycled' = 'all',
): Promise<{ items: OrderRecord[]; total: number }> {
  const result = await extensions().list<StoreOrderData>(orderModel, {
    ...(recycled === 'active' ? { where: { deletedAt: { eq: null } } } : {}),
    orderBy: { field: 'createdAt', desc: true },
    page,
    pageSize,
  });
  const items = result.items.map(toOrder);
  if (recycled !== 'recycled') return { items, total: result.total };
  // “只看回收站”无法用一个索引条件表达（`deletedAt != null` 不是引擎支持的
  // where 形状），所以在页内过滤；分页总数保持原值，调用方不得把它当精确总数。
  return { items: items.filter((order) => order.deletedAt !== null), total: result.total };
}

/** 把订单移入/移出回收站（`null` = 移出）。返回是否命中该订单。 */
export async function setOrderDeletedAt(id: string, deletedAt: string | null): Promise<boolean> {
  const { updated } = await extensions().updateWhere(
    orderModel,
    { name: { eq: id } },
    {
      deletedAt: { set: deletedAt },
      // 两列必须一起写：范围查询只看 `deletedAtMs`，展示只看 `deletedAt`。
      deletedAtMs: { set: deletedAt === null ? null : Date.parse(deletedAt) },
    },
  );
  return updated > 0;
}

/** 回收站中回收时间不晚于 `cutoff` 的订单（供定时清理扫描）。 */
export async function listRecycledOrdersBefore(
  cutoff: string,
  limit: number,
): Promise<OrderRecord[]> {
  const cutoffMs = Date.parse(cutoff);
  const page = await extensions().list<StoreOrderData>(orderModel, {
    where: { deletedAtMs: { lte: cutoffMs } },
    orderBy: { field: 'deletedAtMs', desc: false },
    page: 1,
    pageSize: limit,
  });
  return page.items.map(toOrder);
}

/** 物理删除一条订单（仅回收站清理使用）。 */
export async function deleteOrderInstance(id: string): Promise<void> {
  await extensions().delete(orderModel, id);
}

export interface OrderCreateInput
  extends Omit<StoreOrderData, 'state' | 'deletedAt' | 'deletedAtMs'> {
  state?: string;
}

export async function createOrderInstance(data: OrderCreateInput): Promise<OrderRecord> {
  const created = await extensions().create<StoreOrderData>(orderModel, {
    state: 'PENDING',
    deletedAt: null,
    deletedAtMs: null,
    ...data,
  } as StoreOrderData);
  return toOrder(created);
}

/** 原子状态迁移：仅当当前状态匹配时变更。 */
export async function changeOrderState(
  id: string,
  from: string | string[],
  to: string,
): Promise<boolean> {
  const fromCondition = Array.isArray(from) ? { in: from } : { eq: from };
  const { updated } = await extensions().updateWhere(
    orderModel,
    { name: { eq: id }, state: fromCondition },
    { state: { set: to } },
  );
  return updated > 0;
}

export async function replaceOrder(id: string, data: StoreOrderData): Promise<void> {
  await extensions().update<StoreOrderData>(orderModel, id, data);
}

/* --------------------------- 服务实例 --------------------------- */

export async function listServicesByUser(userId: string): Promise<ServiceInstanceRecord[]> {
  const rows = await extensions().listAll<StoreServiceInstanceData>(serviceInstanceModel, {
    where: { userId: { eq: userId } },
    orderBy: { field: 'createdAt', desc: true },
  });
  return rows.map(toService);
}

export async function getService(id: string): Promise<ServiceInstanceRecord | null> {
  const instance = await extensions().get<StoreServiceInstanceData>(serviceInstanceModel, id);
  return instance ? toService(instance) : null;
}

/** 按上游服务标识查找已绑定的交付物（任意用户；上游服务全局唯一绑定）。 */
export async function findServiceByProviderService(
  providerId: string,
  providerServiceId: string,
): Promise<ServiceInstanceRecord | null> {
  const page = await extensions().list<StoreServiceInstanceData>(serviceInstanceModel, {
    where: {
      providerId: { eq: providerId },
      providerServiceId: { eq: providerServiceId },
    },
    page: 1,
    pageSize: 1,
  });
  const item = page.items[0];
  return item ? toService(item) : null;
}

/** 列出某上游提供方下所有已绑定的交付物（用于「已绑定」标记）。 */
export async function listServicesByProvider(providerId: string): Promise<ServiceInstanceRecord[]> {
  const rows = await extensions().listAll<StoreServiceInstanceData>(serviceInstanceModel, {
    where: { providerId: { eq: providerId } },
    orderBy: { field: 'createdAt', desc: true },
  });
  return rows.map(toService);
}

export async function listServicesPage(
  page: number,
  pageSize: number,
  status?: string,
): Promise<{ items: ServiceInstanceRecord[]; total: number }> {
  const result = await extensions().list<StoreServiceInstanceData>(serviceInstanceModel, {
    where: status ? { state: { eq: status } } : {},
    orderBy: { field: 'createdAt', desc: true },
    page,
    pageSize,
  });
  return { items: result.items.map(toService), total: result.total };
}

export async function createServiceInstance(
  data: Omit<
    StoreServiceInstanceData,
    | 'state'
    | 'expiresAt'
    | 'expiresAtMs'
    | 'expiryStage'
    | 'expiryAttempts'
    | 'expiryLastError'
    | 'terminatedAt'
  > & {
    state: string;
    expiresAt?: string | null;
    terminatedAt?: string | null;
  },
  name?: string,
): Promise<ServiceInstanceRecord> {
  if (name) {
    const existing = await getService(name);
    if (existing) return existing;
  }
  try {
  const created = await extensions().create<StoreServiceInstanceData>(serviceInstanceModel, {
    expiresAt: null,
    expiryStage: null,
    expiryAttempts: 0,
    expiryLastError: null,
    terminatedAt: null,
    ...data,
    // 派生过期毫秒列：以 expiresAt 为唯一真源，避免两处漂移。
    expiresAtMs: toEpochMs(data.expiresAt ?? null),
  }, name ? { name } : undefined);
  return toService(created);
  } catch (error) {
    const existing = name ? await getService(name) : null;
    if (existing) return existing;
    throw error;
  }
}

export async function replaceServiceInstance(
  id: string,
  data: StoreServiceInstanceData,
  opts?: { expectedVersion?: number },
): Promise<void> {
  await extensions().update<StoreServiceInstanceData>(
    serviceInstanceModel,
    id,
    {
      ...data,
      expiresAtMs: toEpochMs(data.expiresAt),
    },
    opts,
  );
}

/**
 * 仅更新交付物的少量字段（**整行读改写**：先按 `name` 读出、校验 `expiryStage` 仍为
 * `expectedStage`，再合并 patch 整行落库）。内核 `updateWhere` 只接受 `indexes` 中声明
 * 过的字段，而 `terminatedAt`/`expiryAttempts`/`expiryLastError` 未声明为索引（也无需
 * 查询），因此这里改用整行更新以携带这些字段；`state`/`expiryStage` 的并发安全由调用方
 * 先经 `claimExpiryStage` 原子认领阶段来保证。
 *
 * 另以**乐观锁** `expectedVersion`（读到的 `instance.version`）兜底：若读与写之间该行被
 * 并发修改（如用户续费重置了 `expiryStage`/顺延了 `expiresAt`），`update` 抛
 * `ExtensionVersionConflict`，此处吞掉返回 `false`，避免用陈旧快照覆盖并发写入。
 */
export async function patchServiceInstance(
  id: string,
  expectedStage: string,
  patch: Partial<
    Record<
      'state' | 'terminatedAt' | 'expiryStage' | 'expiryAttempts' | 'expiryLastError',
      { set: unknown }
    >
  >,
): Promise<boolean> {
  const instance = await extensions().get<StoreServiceInstanceData>(serviceInstanceModel, id);
  if (!instance) return false;
  const service = toService(instance);
  if (service.expiryStage !== expectedStage) return false;
  const next = toServiceInstanceData(service);
  if ('state' in patch && patch.state) next.state = patch.state.set as string;
  if ('expiryStage' in patch && patch.expiryStage)
    next.expiryStage = patch.expiryStage.set as string | null;
  if ('expiryAttempts' in patch && patch.expiryAttempts)
    next.expiryAttempts = patch.expiryAttempts.set as number;
  if ('expiryLastError' in patch && patch.expiryLastError)
    next.expiryLastError = patch.expiryLastError.set as string | null;
  if ('terminatedAt' in patch && patch.terminatedAt)
    next.terminatedAt = patch.terminatedAt.set as string | null;
  try {
    await replaceServiceInstance(id, next, { expectedVersion: instance.version });
  } catch (error) {
    if (isExtensionVersionConflict(error)) return false;
    throw error;
  }
  return true;
}

/**
 * 记录一次到期动作（暂停/终止）的上游失败：自增尝试次数、写最后错误；**不动 state**，
 * 阶段停留在「处理中」以便下一轮 sweep 重试。返回是否命中（阶段已变更或并发冲突时不写入）。
 */
export async function markExpiryFailure(
  id: string,
  expectedStage: string,
  error: unknown,
): Promise<boolean> {
  const message = error instanceof Error && error.message ? error.message : '未知错误';
  const instance = await extensions().get<StoreServiceInstanceData>(serviceInstanceModel, id);
  if (!instance) return false;
  const service = toService(instance);
  if (service.expiryStage !== expectedStage) return false;
  try {
    await replaceServiceInstance(
      id,
      {
        ...toServiceInstanceData(service),
        expiryAttempts: (service.expiryAttempts ?? 0) + 1,
        expiryLastError: message,
      },
      { expectedVersion: instance.version },
    );
  } catch (error) {
    if (isExtensionVersionConflict(error)) return false;
    throw error;
  }
  return true;
}

/** ISO 时间 → epoch 毫秒；空值或非法值返回 null。 */
export function toEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 原子推进到期阶段：仅当当前阶段匹配 `from` 时置为 `to`，返回是否命中。
 * 用于让周期扫描对同一服务在每个阶段只动作一次（并发下由 DB 保证幂等）。
 */
export async function claimExpiryStage(
  id: string,
  from: string | null,
  to: string,
): Promise<boolean> {
  const { updated } = await extensions().updateWhere(
    serviceInstanceModel,
    // `eq: null` 编译为 `IS NULL`（见 extensions/query.ts），语义上精确表示「尚未
    // 进入任何阶段」，而非匹配任意阶段。
    { name: { eq: id }, expiryStage: { eq: from } },
    { expiryStage: { set: to } },
  );
  return updated > 0;
}

/**
 * 回退到期阶段为「未进入」：仅当当前阶段匹配 `from` 时置 NULL，返回是否命中。
 * 用于「认领阶段 → 副作用失败」时把阶段释放回可重试状态（如提醒写入失败）。
 */
export async function resetExpiryStage(
  id: string,
  from: string,
  to: string | null = null,
): Promise<boolean> {
  const { updated } = await extensions().updateWhere(
    serviceInstanceModel,
    { name: { eq: id }, expiryStage: { eq: from } },
    // `set: null` 编译为 SQL NULL（与 claimExpiryStage 的 `eq: null` 对称）。
    { expiryStage: { set: to } },
  );
  return updated > 0;
}

/**
 * 列出到期提醒链的下一档候选：阶段仍是 `fromStage`、且到期时间已进入触发窗口。
 *
 * 逐档查询（而不是把所有阶段一次捞出来再在内存里判断）有两个好处：每档都能单独
 * 限批，不会因为一档积压把后面几档饿死；锁语义也简单 —— `fromStage` 就是
 * `claimExpiryStage` 的 CAS 前置条件。
 */
export async function listReminderCandidates(
  fromStage: string | null,
  dueBeforeMs: number,
  take: number,
): Promise<ServiceInstanceRecord[]> {
  const rows = await extensions().listAll<StoreServiceInstanceData>(serviceInstanceModel, {
    where: {
      state: { eq: 'ACTIVE' },
      expiresAtMs: { lte: dueBeforeMs },
      expiryStage: { eq: fromStage },
    },
    orderBy: { field: 'expiresAtMs', desc: false },
  });
  return rows.slice(0, take).map(toService);
}

/** 列出「已到期／临近到期」的活跃服务（按 expiresAtMs 升序，上限 take）。 */
export async function listExpiringServices(
  nowMs: number,
  take: number,
): Promise<ServiceInstanceRecord[]> {
  const rows = await extensions().listAll<StoreServiceInstanceData>(serviceInstanceModel, {
    where: {
      state: { in: ['ACTIVE', 'SUSPENDED'] },
      expiresAtMs: { lte: nowMs },
    },
    orderBy: { field: 'expiresAtMs', desc: false },
  });
  return rows.slice(0, take).map(toService);
}

export async function deleteServiceInstance(id: string): Promise<void> {
  await extensions().delete(serviceInstanceModel, id);
}

/* --------------------------- 履约任务 --------------------------- */

export async function getTask(id: string): Promise<DeliveryTaskRecord | null> {
  const instance = await extensions().get<StoreDeliveryTaskData>(deliveryTaskModel, id);
  return instance ? toTask(instance) : null;
}

export async function createTaskInstance(data: StoreDeliveryTaskData, unitIndex = 0): Promise<DeliveryTaskRecord> {
  // Storage primary key, not a read-before-write check, arbitrates concurrent callbacks.
  const name = `delivery-${data.orderId}-${data.productId}${unitIndex ? `-unit-${unitIndex + 1}` : ''}`;
  try {
    return toTask(await extensions().create<StoreDeliveryTaskData>(deliveryTaskModel, data, { name }));
  } catch (error) {
    const existing = await getTask(name);
    if (existing && existing.orderId === data.orderId && existing.productId === data.productId) return existing;
    throw error;
  }
}

export async function replaceTask(id: string, data: StoreDeliveryTaskData): Promise<void> {
  await extensions().update<StoreDeliveryTaskData>(deliveryTaskModel, id, data);
}

export async function listDueTasks(nowMs: number, take: number): Promise<DeliveryTaskRecord[]> {
  const rows = await extensions().listAll<StoreDeliveryTaskData>(deliveryTaskModel, {
    where: {
      state: { eq: 'PENDING' },
      nextAttemptAtMs: { lte: nowMs },
    },
    orderBy: { field: 'nextAttemptAtMs', desc: false },
  });
  return rows.slice(0, take).map(toTask);
}

/** 某订单已创建的履约任务（用于入队幂等：同一 (orderId, productId) 只建一次）。 */
export async function listTasksByOrder(orderId: string): Promise<DeliveryTaskRecord[]> {
  const rows = await extensions().listAll<StoreDeliveryTaskData>(deliveryTaskModel, {
    where: { orderId: { eq: orderId } },
  });
  return rows.map(toTask);
}

/**
 * 认领一个到期任务（原子）。`leaseUntilMs` 写入 `nextAttemptAtMs` 作为**租约到期**：
 * 任务处于 RUNNING 时该字段表示「认领者必须在此前完成」，超时即可被回收重试。
 */
export async function claimTask(id: string, leaseUntilMs: number): Promise<boolean> {
  const task = await getTask(id);
  if (!task) return false;
  return runTransaction(async tx => {
  const paid = await tx.extensions.updateWhere(orderModel,
    { name: { eq: task.orderId }, state: { eq: 'PAID' } }, { state: { set: 'PAID' } });
  if (paid.updated !== 1) return false;
  const { updated } = await tx.extensions.updateWhere(
    deliveryTaskModel,
    { name: { eq: id }, state: { eq: 'PENDING' } },
    { state: { set: 'RUNNING' }, attempts: { inc: 1 }, nextAttemptAtMs: { set: leaseUntilMs } },
  );
  return updated > 0;
  });
}

/** 列出超过租约仍停留在 RUNNING 的任务（认领者已死，需要回收）。 */
export async function listStaleRunningTasks(nowMs: number, take: number): Promise<DeliveryTaskRecord[]> {
  const rows = await extensions().listAll<StoreDeliveryTaskData>(deliveryTaskModel, {
    where: {
      state: { eq: 'RUNNING' },
      nextAttemptAtMs: { lte: nowMs },
    },
    orderBy: { field: 'nextAttemptAtMs', desc: false },
  });
  return rows.slice(0, take).map(toTask);
}

/**
 * 回收超租约的 RUNNING 任务：还有重试次数就回到 PENDING（立即可跑），否则置 FAILED。
 * 返回 `true` 表示已转 PENDING 待重试。
 *
 * 用 `update`（整行 + 乐观锁）而非 `updateWhere`：`error` 未声明为索引，`updateWhere`
 * 不接受它；顺带以 `expectedVersion` 保证「仅回收仍是同一 RUNNING 行」，避免与真正的
 * 执行者/另一轮回收竞态。
 */
export async function reclaimTask(
  id: string,
  nowMs: number,
  retryable: boolean,
): Promise<boolean> {
  const instance = await extensions().get<StoreDeliveryTaskData>(deliveryTaskModel, id);
  if (!instance || instance.spec.state !== 'RUNNING') return false;
  const task = toTask(instance);
  const next: StoreDeliveryTaskData = retryable
    ? { ...toTaskData(task), state: 'PENDING', nextAttemptAtMs: nowMs }
    : { ...toTaskData(task), state: 'REQUIRES_RECONCILIATION', error: '开通请求超时，需核对上游结果', nextAttemptAtMs: 0 };
  try {
    await extensions().update<StoreDeliveryTaskData>(deliveryTaskModel, id, next, {
      expectedVersion: instance.version,
    });
  } catch (error) {
    if (isExtensionVersionConflict(error)) return false;
    throw error;
  }
  return retryable;
}

export async function listTasksPage(
  page: number,
  pageSize: number,
  filter: { status?: string; orderId?: string },
): Promise<{ items: DeliveryTaskRecord[]; total: number }> {
  const where: Record<string, { eq: unknown } | { in: string[] }> = {};
  if (filter.status === 'attention') where['state'] = { in: ['AWAITING_APPROVAL', 'REQUIRES_RECONCILIATION', 'FAILED'] };
  else if (filter.status) where['state'] = { eq: filter.status };
  if (filter.orderId) where['orderId'] = { eq: filter.orderId };
  const result = await extensions().list<StoreDeliveryTaskData>(deliveryTaskModel, {
    where,
    orderBy: { field: 'createdAt', desc: true },
    page,
    pageSize,
  });
  return { items: result.items.map(toTask), total: result.total };
}

/** 重试失败任务（原子）：状态 FAILED → PENDING 并清零计数。 */
export async function retryFailedTask(id: string, nowMs: number): Promise<boolean> {
  const { updated } = await extensions().updateWhere(
    deliveryTaskModel,
    { name: { eq: id }, state: { eq: 'FAILED' } },
    {
      state: { set: 'PENDING' },
      attempts: { set: 0 },
      nextAttemptAtMs: { set: nowMs },
    },
  );
  return updated > 0;
}

export async function approveDeliveryTask(id: string): Promise<boolean> {
  const { updated } = await extensions().updateWhere(deliveryTaskModel,
    { name: { eq: id }, state: { eq: 'AWAITING_APPROVAL' } },
    { state: { set: 'PENDING' }, nextAttemptAtMs: { set: 0 } });
  return updated === 1;
}

export { isoOrNull };
