/**
 * 上游商品关联 SPI（Upstream SPI）。
 *
 * 商品创建/编辑时可以「关联上游商品」：由上游插件（如智简魔方）实现本接口，
 * 提供「这个上游有哪些商品可关联」。store 只读取活跃的 source 并代理搜索，
 * 对任何具体上游零感知；未安装任何上游插件时，商品表单不显示关联区块。
 *
 * 关联行为（在 store 商品表单里完成）：
 *  - 选择上游商品 → 写入 `product.providerId` + `product.providerProductId`；
 *  - 同步上游价格到 `product.cost`（成本，仅后台可见）；
 *  - 标题/简介/图标默认预填上游信息（可改）；售卖价 `product.price` 独立设置。
 */

/** 上游侧的一个商品条目。 */
export interface UpstreamProductItem {
  /** 上游商品 id（存到 product.providerProductId）。 */
  id: string;
  name: string;
  /** 上游价格（分单位），同步为成本 product.cost。 */
  price: number | null;
  currency?: string | undefined;
  description?: string | null | undefined;
  /** 图标（emoji 或 URL），预填到 product.metadata.icon。 */
  icon?: string | null | undefined;
  /** 规格（CPU/内存等），预填到 product.metadata.specs。 */
  specs?: Record<string, unknown> | undefined;
  status?: string | undefined;
  /** 上游实例标识（同一上游插件可能配了多个实例/账号，如多个魔方），用于关联时定位。 */
  sourceRef?: string | undefined;
}

/**
 * 上游侧一个「已购服务 / 主机」条目。用于管理端把上游已经购买的服务
 * **绑定**到某个平台账号，使其在平台侧显示为该账号已购（不重新开通）。
 */
export interface UpstreamServiceItem {
  /** 上游服务 id（绑定后写入本地交付物的 `providerServiceId`）。 */
  id: string;
  /** 展示名（主机名 / 域名，回退到商品名）。 */
  name: string;
  /** 上游商品名（可空）。 */
  productName?: string | null | undefined;
  /** 上游原始状态码。 */
  status?: string | null | undefined;
  /** 上游状态文案。 */
  statusLabel?: string | null | undefined;
  /** 主机 / IP（可空）。 */
  host?: string | null | undefined;
  /** 到期时间（ISO，可空）。 */
  expiresAt?: string | null | undefined;
  /** 上游金额（分单位，可空）。 */
  amount?: number | null | undefined;
  currency?: string | null | undefined;
  /** 上游实例标识（同一插件配置多个实例/账号时用于定位）。 */
  sourceRef?: string | null | undefined;
}

/**
 * 上游「已购服务」数据源（由上游插件注册）。
 *
 * 与 {@link UpstreamProductSource} 平行：商品源负责商品关联，本接口负责
 * 「这个上游账号下已经买了哪些服务」。store 聚合所有活跃 source，管理端据此
 * 提供「绑定上游已购服务到账号」；未安装上游插件时不显示该入口。
 */
export interface UpstreamServiceSource {
  readonly id: string;
  readonly name: string;
  /** 列出上游已购服务（实时拉取）。 */
  list(options?: { limit?: number }): Promise<UpstreamServiceItem[]>;
}

/** 一个上游平台的商品数据源（由上游插件注册）。 */
export interface UpstreamProductSource {
  readonly id: string;
  readonly name: string;
  /** 搜索上游商品（供商品表单的「关联上游商品」选择器）。 */
  search(query: string, options?: { limit?: number }): Promise<UpstreamProductItem[]>;
  /** 取单个上游商品（编辑商品时回显当前关联）。 */
  get(id: string): Promise<UpstreamProductItem | null>;
  /**
   * 商品建立/解除关联时由 store 回调（可选）。外部上游（如魔方）用它在自己
   * 的表里建立本地商品 ↔ 上游商品的映射（履约时据此定位上游实例）。
   */
  associate?(input: { productId: string; item: UpstreamProductItem }): Promise<void>;
  dissociate?(productId: string): Promise<void>;
}
