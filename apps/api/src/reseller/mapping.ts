/**
 * SP v1 履约资源映射（P3 / PLAN-open-platform §7）。
 *
 * SP v1 是平台既有领域能力（商品 / 订单 / 交付物）的网络化出口，不是第二套实现。
 * 自 E4 起，**商品 / 订单 / 交付物的领域真值归 store 插件**（Extension 模型），
 * 内核不再直读这些表，而是经 `EXTENSION_POINTS.commerce` 调用领域操作：
 *   - `catalog`：公开目录（仅售中商品）。
 *   - `order`：为渠道伙伴的关联用户下单（服务端权威计价 + 原子扣库存 + 发布
 *     `order.paid`），履约由 store 插件既有订阅完成。
 *   - `service`：读渠道伙伴关联用户的交付物，生命周期动作转发给 store 的履约提供方。
 *
 * 内核在此只保留 SP 协议层：身份锚点解析（渠道系统用户）、公开投影、错误映射。
 *
 * 渠道伙伴没有平台用户身份，故为其惰性创建一个系统用户（`reseller+<keyId>@…`），
 * 归属默认 `user` 权限组，作为订单 / 交付物的归属锚点。
 */
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@stackpanel/db';
import type {
  CommerceOperations,
  CommerceOrder,
  CommerceProduct,
  CommerceService,
} from '@stackpanel/sdk';
import { isCommerceError } from '@stackpanel/sdk';
import type { ResellerRecord } from './repository.ts';

export class MappingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const RESELLER_USER_DOMAIN = 'reseller.stackpanel.local';

function resellerUserEmail(reseller: ResellerRecord): string {
  return `reseller+${reseller.keyId.toLowerCase()}@${RESELLER_USER_DOMAIN}`;
}

/**
 * Resolve (or lazily create) the platform user that owns a reseller's orders and
 * services. The user has no password and belongs to the default `user` group.
 * This is an identity-domain concern, so it stays in the kernel.
 */
export async function resolveResellerUser(
  prisma: PrismaClient,
  reseller: ResellerRecord,
): Promise<string> {
  const email = resellerUserEmail(reseller);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing.id;
  try {
    const created = await prisma.user.create({
      data: { email, groups: { create: [{ groupId: 'group_user' }] } },
    });
    return created.id;
  } catch {
    // Race with a concurrent first request: re-read.
    const again = await prisma.user.findUnique({ where: { email } });
    if (again) return again.id;
    throw new MappingError(500, 'sp_v1.user_resolve_failed', '渠道用户解析失败');
  }
}

/** Map a commerce-domain rejection to the SP v1 stable problem contract. */
function mapCommerceError(error: unknown): never {
  if (isCommerceError(error)) {
    switch (error.failure) {
      case 'product_unavailable':
        throw new MappingError(409, 'sp_v1.product_unavailable', '商品不可用或库存不足');
      case 'amount_invalid':
        throw new MappingError(400, 'sp_v1.order_amount_invalid', '订单金额无效');
      case 'product_not_found':
        throw new MappingError(404, 'sp_v1.catalog_item_not_found', '商品不存在');
    }
  }
  throw error;
}

/* ----------------------------- catalog ---------------------------------- */

export interface SpCatalogQuery {
  page?: number | undefined;
  pageSize?: number | undefined;
  categoryId?: string | null | undefined;
}

/** GET catalog: 列出售中商品的公开子集。 */
export async function listCatalog(
  ops: CommerceOperations,
  query: SpCatalogQuery,
): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
  const result = await ops.listCatalog({
    page: query.page,
    pageSize: query.pageSize,
    categoryId: query.categoryId,
  });
  return {
    items: result.items.map(publicCatalogItem),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  };
}

/** GET catalog item by id. */
export async function getCatalogItem(ops: CommerceOperations, id: string): Promise<unknown> {
  const item = await ops.getCatalogItem(id);
  if (!item) throw new MappingError(404, 'sp_v1.catalog_item_not_found', '商品不存在');
  return publicCatalogItem(item);
}

function publicCatalogItem(product: CommerceProduct): Record<string, unknown> {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    currency: product.currency,
    stock: product.stock,
    categoryId: product.categoryId,
    fulfillmentType: product.fulfillmentType,
    providerId: product.providerId,
    providerProductId: product.providerProductId,
    // Only customer-facing metadata (mirrors store's public projection).
    metadata: publicMetadata(product.metadata),
    createdAt: product.createdAt,
  };
}

function publicMetadata(metadata: unknown): Prisma.JsonValue | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  if (record['specs'] !== undefined) keep['specs'] = record['specs'];
  if (record['checkoutConfig'] !== undefined) keep['checkoutConfig'] = record['checkoutConfig'];
  return Object.keys(keep).length > 0 ? (keep as Prisma.JsonValue) : null;
}

/* ------------------------------- order ---------------------------------- */

export interface SpOrderInput {
  productId: string;
  quantity: number;
  /** 渠道自定义下单参考（写入订单渠道码后缀，便于对账）。 */
  channelCode?: string | undefined;
}

/**
 * POST order: 为渠道伙伴创建订单。计价与扣库存由 store 插件权威执行；订单标记
 * PAID（渠道为预付伙伴）并由 store 发布 `order.paid` 触发履约。
 */
export async function createOrder(
  prisma: PrismaClient,
  ops: CommerceOperations,
  reseller: ResellerRecord,
  input: SpOrderInput,
): Promise<unknown> {
  const userId = await resolveResellerUser(prisma, reseller);
  const channelCode = `SP_V1:${reseller.keyId}${input.channelCode ? `:${input.channelCode}` : ''}`;
  let order: CommerceOrder;
  try {
    order = await ops.createOrder({
      userId,
      productId: input.productId,
      quantity: input.quantity,
      channelCode,
    });
  } catch (error) {
    mapCommerceError(error);
  }
  return {
    order: {
      id: order.id,
      status: order.status,
      total: order.total,
      currency: order.currency,
      items: orderLineItems(order),
      createdAt: order.createdAt,
    },
  };
}

/** GET order by id, scoped to the reseller's linked user. */
export async function getOrder(
  prisma: PrismaClient,
  ops: CommerceOperations,
  reseller: ResellerRecord,
  id: string,
): Promise<unknown> {
  const userId = await resolveResellerUser(prisma, reseller);
  const order = await ops.getOrder(userId, id);
  if (!order) throw new MappingError(404, 'sp_v1.order_not_found', '订单不存在');
  return { order: orderView(order) };
}

/** GET orders for the reseller (newest first). */
export async function listOrders(
  prisma: PrismaClient,
  ops: CommerceOperations,
  reseller: ResellerRecord,
  page = 1,
  pageSize = 20,
): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
  const userId = await resolveResellerUser(prisma, reseller);
  const result = await ops.listOrders(userId, page, pageSize);
  return {
    items: result.items.map(orderView),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  };
}

function orderView(order: CommerceOrder): Record<string, unknown> {
  return {
    id: order.id,
    status: order.status,
    total: order.total,
    currency: order.currency,
    items: order.items,
    createdAt: order.createdAt,
  };
}

/** 从订单载荷抽取 SP 下单响应的行项目（与原实现保持一致的 `unit` 字段）。 */
function orderLineItems(order: CommerceOrder): Array<{
  productId: string;
  quantity: number;
  unit: number;
}> {
  const value = order.items as {
    items?: Array<{ productId?: unknown; quantity?: unknown; price?: unknown }>;
  };
  return (value.items ?? []).flatMap((item) =>
    typeof item.productId === 'string' &&
    typeof item.quantity === 'number' &&
    typeof item.price === 'number'
      ? [{ productId: item.productId, quantity: item.quantity, unit: item.price }]
      : [],
  );
}

/* ------------------------------ service --------------------------------- */

/** GET services for the reseller's linked user. */
export async function listServices(
  prisma: PrismaClient,
  ops: CommerceOperations,
  reseller: ResellerRecord,
): Promise<{ items: unknown[] }> {
  const userId = await resolveResellerUser(prisma, reseller);
  const services = await ops.listServices(userId);
  return { items: services.map(serviceView) };
}

/** GET one service, scoped to the reseller. */
export async function getService(
  prisma: PrismaClient,
  ops: CommerceOperations,
  reseller: ResellerRecord,
  id: string,
): Promise<unknown> {
  const userId = await resolveResellerUser(prisma, reseller);
  const service = await ops.getService(userId, id);
  if (!service) throw new MappingError(404, 'sp_v1.service_not_found', '交付物不存在');
  return { service: serviceView(service) };
}

function serviceView(service: CommerceService): Record<string, unknown> {
  return {
    id: service.id,
    productId: service.productId,
    productName: service.productName,
    fulfillmentType: service.fulfillmentType,
    providerId: service.providerId,
    providerServiceId: service.providerServiceId,
    status: service.status,
    runtime: service.runtime,
    amount: service.amount,
    currency: service.currency,
    expiresAt: service.expiresAt,
    provisionedAt: service.provisionedAt,
    createdAt: service.createdAt,
  };
}

export type ServiceLifecycleAction = 'suspend' | 'resume' | 'terminate';

/**
 * Run a lifecycle action by delegating to the store plugin's commerce outlet,
 * which forwards to the product's registered fulfillment provider and records
 * the resulting status. The kernel keeps the SP envelope and error contract.
 */
export async function runServiceLifecycle(
  prisma: PrismaClient,
  ops: CommerceOperations,
  reseller: ResellerRecord,
  id: string,
  action: ServiceLifecycleAction,
): Promise<{ service: unknown }> {
  const userId = await resolveResellerUser(prisma, reseller);
  const service = await ops.runServiceLifecycle(userId, id, action);
  if (!service) throw new MappingError(404, 'sp_v1.service_not_found', '交付物不存在');
  return { service: serviceView(service) };
}

/** Opaque correlation id for an SP v1 write (used as a default idempotency seed). */
export function newRequestId(): string {
  return `sp_${randomUUID()}`;
}
