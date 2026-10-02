/**
 * 商业域操作契约（`EXTENSION_POINTS.commerce`）。
 *
 * 商品 / 订单 / 交付物的**业务真值**归商业插件（store）所有。内核不直读这些表，
 * 而是经本扩展点调用领域操作——内核保留对外协议（SP v1 签名、幂等、管理端编排），
 * 商业插件保留领域实现（计价、扣库存、履约、生命周期）。消费者只依赖本结构镜像，
 * 与 `store.product.read` / `store.product.update` 同源。
 */

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
export type CommerceFailure = 'product_unavailable' | 'amount_invalid' | 'product_not_found';

/** A deterministic business rejection from the commerce domain. */
export class CommerceError extends Error {
  constructor(
    readonly failure: CommerceFailure,
    message: string,
  ) {
    super(message);
    this.name = 'CommerceError';
  }
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
}
