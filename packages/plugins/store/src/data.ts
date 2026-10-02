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
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['state'], types: { state: 'string' } },
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
    provisionedAt: z.string().nullable().default(null),
    terminatedAt: z.string().nullable().default(null),
  }),
  indexes: [
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['orderId'], types: { orderId: 'string' } },
    { fields: ['productId'], types: { productId: 'string' } },
    { fields: ['state'], types: { state: 'string' } },
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
  }),
  indexes: [
    { fields: ['state'], types: { state: 'string' } },
    { fields: ['orderId'], types: { orderId: 'string' } },
    { fields: ['userId'], types: { userId: 'string' } },
    { fields: ['nextAttemptAtMs'], types: { nextAttemptAtMs: 'number' } },
    { fields: ['attempts'], types: { attempts: 'integer' } },
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
}
