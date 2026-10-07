/**
 * 商业域操作契约（`EXTENSION_POINTS.commerce`）。
 *
 * 商品 / 订单 / 交付物的**业务真值**归商业插件（store）所有。内核不直读这些表，
 * 而是经本扩展点调用领域操作——内核保留对外协议（SP v1 签名、幂等、管理端编排），
 * 商业插件保留领域实现（计价、扣库存、履约、生命周期）。消费者只依赖本结构镜像，
 * 与 `store.product.read` / `store.product.update` 同源。
 */

import { KernelError, brandSdkErrorClass, isSdkErrorClass } from './errors.js';

/** 面向调用方的商品视图（售中公开子集 + 管理所需字段）。 */
export interface CommerceProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number;
  status: string;
  categoryId: string | null;
  fulfillmentType: string;
  providerId: string | null;
  providerProductId: string | null;
  metadata: unknown;
  createdAt: Date;
}

/** 订单视图。 */
export interface CommerceOrder {
  id: string;
  userId: string;
  items: unknown;
  total: number;
  currency: string;
  status: string;
  channelCode: string | null;
  createdAt: Date;
}

/** 交付物 / 服务实例视图。 */
export interface CommerceService {
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
  provisionedAt: Date | null;
  terminatedAt: Date | null;
  createdAt: Date;
}

export interface CommerceList<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type CommerceServiceAction = 'suspend' | 'resume' | 'terminate';

/** 领域拒绝原因，由调用方（内核）映射为自己的稳定错误码。 */
export type CommerceFailure =
  'product_unavailable' | 'amount_invalid' | 'product_not_found' | 'service_already_bound';

/** HTTP status the kernel error boundary renders for each domain failure. */
const COMMERCE_FAILURE_STATUS: Record<CommerceFailure, number> = {
  product_unavailable: 409,
  amount_invalid: 400,
  product_not_found: 404,
  service_already_bound: 409,
};

/** A deterministic business rejection from the commerce domain. */
export class CommerceError extends KernelError {
  constructor(
    readonly failure: CommerceFailure,
    message: string,
  ) {
    super(`commerce.${failure}`, COMMERCE_FAILURE_STATUS[failure] ?? 409, message);
    this.name = 'CommerceError';
  }
}

brandSdkErrorClass(CommerceError, 'CommerceError');

/** True when `value` is a {@link CommerceError}, even across duplicated SDK modules. */
export function isCommerceError(value: unknown): value is CommerceError {
  return isSdkErrorClass(value, 'CommerceError');
}

export interface CommerceCatalogQuery {
  page?: number | undefined;
  pageSize?: number | undefined;
  categoryId?: string | null | undefined;
}

export interface CommerceOrderInput {
  /** 平台用户（订单归属锚点）。 */
  userId: string;
  productId: string;
  quantity: number;
  channelCode?: string | null | undefined;
}

export interface CommerceServiceInput {
  userId: string;
  productId: string;
  quantity: number;
  expiresAt?: Date | null | undefined;
}

export interface CommerceServicePatch {
  status?: string | undefined;
  expiresAt?: Date | null | undefined;
}

/**
 * 管理端「绑定上游已购服务」入参。
 *
 * 与 {@link CommerceServiceInput}（为某用户开通/赠送本地商品）不同：这里不调用
 * 履约提供方 `provision`，而是把一个**已经存在于上游**的服务登记为本平台某用户
 * 的交付物（写入 `providerId` + `providerServiceId`）。此后详情/监控/生命周期
 * 动作仍由对应履约提供方从上游实时读取。
 */
export interface CommerceBindServiceInput {
  userId: string;
  /** 本地商品 id（上游商品已映射时传入；未映射时用上游商品/占位标识）。 */
  productId: string;
  productName: string;
  fulfillmentType: string;
  /** 上游提供方 id（与 {@link FulfillmentProvider.id} 一致）。 */
  providerId: string;
  /** 上游服务 id（存到交付物 `providerServiceId`）。 */
  providerServiceId: string;
  status: string;
  amount: number;
  currency: string;
  expiresAt?: Date | null | undefined;
  /** 履约提供方解析上游实例所需的运行时数据（如 `{ upstreamId }`）。 */
  runtime?: unknown;
}

/**
 * 商业域操作。由 store 插件实现并注册到 `EXTENSION_POINTS.commerce`；内核
 * （SP v1 出口、管理端）与其它插件经 `runtime.getExtensions` 解析唯一实现。
 */
export interface CommerceOperations {
  readonly id: string;
  /** 公开目录（仅售中商品）。 */
  listCatalog(query: CommerceCatalogQuery): Promise<CommerceList<CommerceProduct>>;
  getCatalogItem(id: string): Promise<CommerceProduct | null>;
  /** 服务端权威计价 + 原子扣库存 + 落单 + 发布 `order.paid`。 */
  createOrder(input: CommerceOrderInput): Promise<CommerceOrder>;
  getOrder(userId: string, id: string): Promise<CommerceOrder | null>;
  listOrders(userId: string, page: number, pageSize: number): Promise<CommerceList<CommerceOrder>>;
  /** 某用户的交付物（不限状态）。 */
  listServices(userId: string): Promise<CommerceService[]>;
  getService(userId: string, id: string): Promise<CommerceService | null>;
  /** 生命周期动作：转发给履约提供方并落状态。找不到返回 `null`。 */
  runServiceLifecycle(
    userId: string,
    id: string,
    action: CommerceServiceAction,
  ): Promise<CommerceService | null>;
  /** 管理端：售中商品简要列表（赠予选择器等）。 */
  listActiveProducts(limit: number): Promise<CommerceProduct[]>;
  /** 管理端：为某用户批量开通交付物（赠予），每件按商品价计价。 */
  createServices(input: CommerceServiceInput): Promise<CommerceService[]>;
  /** 管理端：更新交付物状态 / 到期时间。找不到返回 `null`。 */
  updateService(id: string, patch: CommerceServicePatch): Promise<CommerceService | null>;
  /** 管理端：删除交付物。返回是否命中。 */
  deleteService(id: string): Promise<boolean>;
  /**
   * 管理端：把上游已有服务绑定为某用户的交付物（不重新开通上游）。
   * 同一上游服务已绑定其它账号时抛出领域错误。
   */
  bindService(input: CommerceBindServiceInput): Promise<CommerceService>;
  /** 管理端：列出某上游提供方下所有已绑定的交付物（用于标记「已绑定」）。 */
  listBoundServices(providerId: string): Promise<CommerceService[]>;
}
