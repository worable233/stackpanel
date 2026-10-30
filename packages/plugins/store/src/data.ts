import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/**
 * 商店插件自治数据模型（ADR-0008 / ADR-0009）。
 *
 * 迁移自内核 `products` / `categories` / `cart_items` / `orders` /
 * `service_instances` / `delivery_tasks` 六张表：此后商店只经 `ctx.extensions`
 * 与 `ctx.tx` 读写自己的数据，不再持有裸 DB。
 *
 * 约定：实体生命周期状态字段一律命名为 `state`，因为引擎的 `updateWhere`
 * 把 patch 键 `status` 特殊映射到内建 status 列；用 `state` 才能让「按状态
 * 条件原子变更」落到一个真实索引列上。对外 API 仍以 `status` 暴露。
 */

/** 商品。`status` 只读查询用，不参与 updateWhere（改状态走整条 update）。 */
export const productModel = defineModel({
  kind: 'store/product',
  label: '商品',
  schema: z.object({
    name: z.string(),
    description: z.string().nullable().default(null),
    price: z.number().int(),
    currency: z.string().default('CNY'),
    cost: z.number().int().nullable().default(null),
    originalPrice: z.number().int().nullable().default(null),
    discount: z.number().int().nullable().default(null),
    stock: z.number().int().default(0),
    status: z.string().default('ACTIVE'),
    metadata: z.unknown().nullable().default(null),
    categoryId: z.string().nullable().default(null),
    fulfillmentType: z.string().default('instant'),
    providerId: z.string().nullable().default(null),
    providerProductId: z.string().nullable().default(null),
  }),
  indexes: [
    { fields: ['status'], types: { status: 'string' } },
    { fields: ['categoryId'], types: { categoryId: 'string' } },
    { fields: ['stock'], types: { stock: 'integer' } },
    { fields: ['providerId'], types: { providerId: 'string' } },
  ],
});

/** 商品分类。 */
export const categoryModel = defineModel({
  kind: 'store/category',
  label: '商品分类',
  schema: z.object({
    name: z.string(),
    slug: z.string().nullable().default(null),
    description: z.string().nullable().default(null),
    parentId: z.string().nullable().default(null),
    sortOrder: z.number().int().default(0),
    fulfillmentTypes: z.unknown().nullable().default(null),
    providerId: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
  }),
  indexes: [
    { fields: ['slug'], unique: true, types: { slug: 'string' } },
    { fields: ['enabled'], types: { enabled: 'boolean' } },
    { fields: ['parentId'], types: { parentId: 'string' } },
    { fields: ['sortOrder'], types: { sortOrder: 'integer' } },
  ],
});

/** 购物车项。 */
export const cartItemModel = defineModel({
  kind: 'store/cart-item',
  label: '购物车项',
  schema: z.object({
    userId: z.string(),
    productId: z.string(),
    quantity: z.number().int().default(1),
    config: z.unknown().nullable().default(null),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['productId'], types: { productId: 'string' } },
  ],
});

/** 订单。 */
export const orderModel = defineModel({
  kind: 'store/order',
  label: '订单',
  schema: z.object({
    userId: z.string(),
    items: z.unknown().nullable().default(null),
    total: z.number().int(),
    currency: z.string().default('CNY'),
    state: z.string().default('PENDING'),
    channelCode: z.string().nullable().default(null),
    settlementCurrency: z.string().default('CNY'),
    settlementTotal: z.number().int(),
    fxRate: z.number().int().nullable().default(null),
    /**
     * 回收站时间（用户主动移入回收站的时刻）。
     *
     * 订单不因用户「删掉」而消失：只在这里打一个时间戳，列表默认过滤掉它，
     * 管理员可恢复，超过保留期后由 `order-purge` 任务真正删除。
     * 支付中的订单不允许进回收站，否则一笔仍可完成的支付会从用户视野里消失。
     */
    deletedAt: z.string().nullable().default(null),
    /**
     * `deletedAt` 的 epoch 毫秒镜像，与 `expiresAt`/`expiresAtMs` 同一做法：
     * 索引列只支持数值型范围查询，清理任务需要 `lte` 比较，所以冗余一份
     * 数值回收时间；写入时由 repository 从 `deletedAt` 统一派生。
     */
    deletedAtMs: z.number().int().nullable().default(null),
    /**
     * 未付款催付的**计划发送时间**（epoch ms）：下单时写入「现在 + 24h」。
     *
     * 用「到期时间戳」而不是「每天扫一遍创建时间」，是为了让催付也具备补发能力：
     * 任务停了两天，恢复后第一条满足 `<= now` 的记录照样会发。索引列必须是数值型，
     * 范围比较（`lte`）落在这一列上。
     */
    unpaidRemindAtMs: z.number().int().nullable().default(null),
    /**
     * 已催付时间（ISO 字符串）。非空即「已催过」，是催付的幂等标记 ——
     * 字符串列可以用 `eq: null` 表达「从未催付」，与 `deletedAt` 同一做法。
     */
    unpaidRemindedAt: z.string().nullable().default(null),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['state'], types: { state: 'string' } },
    { fields: ['unpaidRemindAtMs'], types: { unpaidRemindAtMs: 'number' } },
    { fields: ['unpaidRemindedAt'], types: { unpaidRemindedAt: 'string' } },
    // 必需索引：扩展引擎只能按**已声明的索引列**过滤（其余字段会抛
    // ExtensionUnknownField）。`deletedAt: { eq: null }` 用字符串列（IS NULL
    // 可行），但清理任务的范围比较必须落在数值列 `deletedAtMs` 上。
    // 存量行的两列都是 NULL，正好等于「不在回收站」。
    { fields: ['deletedAt'], types: { deletedAt: 'string' } },
    { fields: ['deletedAtMs'], types: { deletedAtMs: 'number' } },
  ],
});

/** 交付物 / 服务实例。 */
export const serviceInstanceModel = defineModel({
  kind: 'store/service-instance',
  label: '交付物',
  schema: z.object({
    userId: z.string(),
    orderId: z.string().nullable().default(null),
    productId: z.string(),
    productName: z.string(),
    fulfillmentType: z.string(),
    providerId: z.string().nullable().default(null),
    providerServiceId: z.string().nullable().default(null),
    state: z.string().default('PENDING_PROVISION'),
    credentialsRef: z.string().nullable().default(null),
    runtime: z.unknown().nullable().default(null),
    amount: z.number().int(),
    currency: z.string().default('CNY'),
    expiresAt: z.string().nullable().default(null),
    /**
     * `expiresAt` 的 epoch 毫秒镜像。索引列只支持数值型范围查询，到期扫描
     * (`gte`/`lte`) 必须落在真实列上，所以这里冗余一份数值到期时间；写入时由
     * repository 从 `expiresAt` 统一派生，避免两处不一致。
     */
    expiresAtMs: z.number().int().nullable().default(null),
    /**
     * 到期处理阶段：`reminded`（已提醒）→ `suspending`（暂停处理中）→
     * `suspended`（上游已确认暂停）→ `terminating`（终止处理中）→ `terminated`
     * （上游已确认终止）。仅用于让周期扫描「每个阶段只动作一次」，续费成功时重置。
     * `suspending`/`terminating` 表示已认领但尚未确认上游，失败时停留在该阶段待重试。
     */
    expiryStage: z.string().nullable().default(null),
    /** 到期动作（暂停/终止）的上游调用尝试次数；成功落终态时清 0。 */
    expiryAttempts: z.number().int().default(0),
    /** 到期动作最后一次上游失败原因；成功落终态时清 null。 */
    expiryLastError: z.string().nullable().default(null),
    provisionedAt: z.string().nullable().default(null),
    terminatedAt: z.string().nullable().default(null),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['orderId'], types: { orderId: 'string' } },
    { fields: ['productId'], types: { productId: 'string' } },
    { fields: ['state'], types: { state: 'string' } },
    { fields: ['providerId'], types: { providerId: 'string' } },
    { fields: ['providerServiceId'], types: { providerServiceId: 'string' } },
    { fields: ['expiresAtMs'], types: { expiresAtMs: 'number' } },
    { fields: ['expiryStage'], types: { expiryStage: 'string' } },
  ],
});

/** 异步履约任务队列。 */
export const deliveryTaskModel = defineModel({
  kind: 'store/delivery-task',
  label: '履约任务',
  schema: z.object({
    orderId: z.string(),
    productId: z.string(),
    userId: z.string(),
    productName: z.string(),
    fulfillmentType: z.string(),
    providerId: z.string().nullable().default(null),
    quantity: z.number().int().default(1),
    state: z.string().default('PENDING'),
    attempts: z.number().int().default(0),
    maxAttempts: z.number().int().default(3),
    error: z.string().nullable().default(null),
    payload: z.unknown().nullable().default(null),
    serviceId: z.string().nullable().default(null),
    /** 下次可执行时刻（epoch 毫秒）；0 表示无延迟（原 null）。 */
    nextAttemptAtMs: z.number().int().default(0),
    /**
     * 自动重试用尽时告知运营的时间。只写一次：排障轮询每 5 分钟跑一轮，没有这个
     * 标记就会把同一条「重试用尽」通知刷成噪音，运营反而会忽略它。
     */
    exhaustedNotifiedAt: z.string().nullable().default(null),
  }),
  indexes: [
    { fields: ['state'], types: { state: 'string' } },
    { fields: ['orderId'], types: { orderId: 'string' } },
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['nextAttemptAtMs'], types: { nextAttemptAtMs: 'number' } },
    { fields: ['attempts'], types: { attempts: 'integer' } },
    { fields: ['exhaustedNotifiedAt'], types: { exhaustedNotifiedAt: 'string' } },
  ],
});

/** 用户退款申请。金额以订单结算币种的最小单位保存，状态迁移只能由服务端完成。 */
export const refundRequestModel = defineModel({
  kind: 'store/refund-request',
  label: '退款申请',
  schema: z.object({
    orderId: z.string(),
    userId: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    reason: z.string().nullable().default(null),
    state: z.string().default('PENDING'),
    reviewerId: z.string().nullable().default(null),
    reviewReason: z.string().nullable().default(null),
    failureReason: z.string().nullable().default(null),
    destination: z.string().default('WALLET'),
    idempotencyKey: z.string().nullable().default(null),
    /**
     * 从**实例页**发起的申请会带上服务 id；订单页发起的申请为 null。
     * 有了它，审核时的停用/恢复/停服才能精确落到那一个实例上。
     */
    serviceId: z.string().nullable().default(null),
    /** 申请时是否已真的把实例停用（关机）。驳回时要据此决定是否恢复。 */
    suspendApplied: z.boolean().default(false),
    /** 审核通过后是否已向上游提交停用申请（不可逆）。 */
    terminateApplied: z.boolean().default(false),
    /** 停服失败原因：钱已退但上游没停掉，必须留痕给运营手工处理。 */
    terminateError: z.string().nullable().default(null),
  }),
  indexes: [
    { fields: ['orderId'], types: { orderId: 'string' } },
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['state'], types: { state: 'string' } },
    { fields: ['serviceId'], types: { serviceId: 'string' } },
  ],
});

/* ------------------------------ 载荷类型 ------------------------------ */

export interface StoreProductData {
  name: string;
  description: string | null;
  price: number;
  currency: string;
  cost: number | null;
  originalPrice: number | null;
  discount: number | null;
  stock: number;
  status: string;
  metadata: unknown;
  categoryId: string | null;
  fulfillmentType: string;
  providerId: string | null;
  providerProductId: string | null;
}

export interface StoreCategoryData {
  name: string;
  slug: string | null;
  description: string | null;
  parentId: string | null;
  sortOrder: number;
  fulfillmentTypes: unknown;
  providerId: string | null;
  enabled: boolean;
}

export interface StoreCartItemData {
  userId: string;
  productId: string;
  quantity: number;
  config: unknown;
}

export interface StoreOrderData {
  userId: string;
  items: unknown;
  total: number;
  currency: string;
  state: string;
  channelCode: string | null;
  settlementCurrency: string;
  settlementTotal: number;
  fxRate: number | null;
  /** 回收站时间（ISO）；存量行没有这个键，读时按 null 处理。 */
  deletedAt?: string | null;
  /** `deletedAt` 的 epoch 毫秒镜像，范围查询用。 */
  deletedAtMs?: number | null;
  /** 未付款催付的计划发送时间（epoch ms）；存量行没有这个键，读时按 null 处理。 */
  unpaidRemindAtMs?: number | null;
  /** 已催付时间（ISO）；非空即「已催过」，是可重复执行的幂等标记。 */
  unpaidRemindedAt?: string | null;
}

export interface StoreServiceInstanceData {
  userId: string;
  orderId: string | null;
  productId: string;
  productName: string;
  fulfillmentType: string;
  providerId: string | null;
  providerServiceId: string | null;
  state: string;
  credentialsRef: string | null;
  runtime: unknown;
  amount: number;
  currency: string;
  expiresAt: string | null;
  /** `expiresAt` 的 epoch 毫秒镜像（索引列，供到期范围扫描）。 */
  expiresAtMs: number | null;
  /** 到期处理阶段：reminded | suspending | suspended | terminating | terminated（每次动作推进一档）。 */
  expiryStage: string | null;
  /** 到期动作（暂停/终止）的上游调用尝试次数；成功落终态时清 0。 */
  expiryAttempts: number;
  /** 到期动作最后一次上游失败原因；成功落终态时清 null。 */
  expiryLastError: string | null;
  provisionedAt: string | null;
  terminatedAt: string | null;
}

export interface StoreDeliveryTaskData {
  orderId: string;
  productId: string;
  userId: string;
  productName: string;
  fulfillmentType: string;
  providerId: string | null;
  quantity: number;
  state: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  payload: unknown;
  serviceId: string | null;
  nextAttemptAtMs: number;
  /** 自动重试用尽时告知运营的时间（只告知一次，防止每次轮询重复刷）。 */
  exhaustedNotifiedAt?: string | null;
}
