/**
 * SP v1 fulfillment-resource mapping (moved out of the kernel under ADR-0021 §D4).
 *
 * SP v1 is the network outlet of the platform's existing domain capabilities
 * (catalog / orders / services), not a second implementation. The domain truth
 * lives in the commerce plugin and is reached through the `commerce.operations`
 * extension point; partner-principal identity is obtained from `ctx.auth`.
 */
import type {
  CommerceOperations,
  CommerceOrder,
  CommerceProduct,
  CommerceService,
} from '@stackpanel/sdk';
import { EXTENSION_POINTS, isCommerceError } from '@stackpanel/sdk';
import { authService, context } from './context';
import type { PartnerRecord } from './repository';

export class MappingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MappingError';
  }
}

const PARTNER_USER_DOMAIN = 'reseller.stackpanel.local';

function partnerUserEmail(partner: PartnerRecord): string {
  return `reseller+${partner.keyId.toLowerCase()}@${PARTNER_USER_DOMAIN}`;
}

/** Resolve the `commerce.operations` outlet; 503 when the commerce plugin is absent. */
export function commerceOperations(): CommerceOperations {
  const ops = context().getExtensions<CommerceOperations>(EXTENSION_POINTS.commerce)[0];
  if (!ops) throw new MappingError(503, 'sp_v1.store_unavailable', '商店能力不可用');
  return ops;
}

/**
 * Resolve (or lazily create) the platform identity that owns a partner's orders
 * and services. Identity is a kernel domain, so this goes through `ctx.auth`.
 */
export async function resolvePartnerUser(partner: PartnerRecord): Promise<string> {
  const user = await authService().ensureSystemUser({ email: partnerUserEmail(partner) });
  return user.id;
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

/** GET catalog: list the public subset of on-sale products. */
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
    metadata: publicMetadata(product.metadata),
    createdAt: product.createdAt,
  };
}

function publicMetadata(metadata: unknown): unknown {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  if (record['specs'] !== undefined) keep['specs'] = record['specs'];
  if (record['checkoutConfig'] !== undefined) keep['checkoutConfig'] = record['checkoutConfig'];
  return Object.keys(keep).length > 0 ? keep : null;
}

/* ------------------------------- order ---------------------------------- */

export interface SpOrderInput {
  productId: string;
  quantity: number;
  /** Partner-defined order reference (written into the channel code for reconciliation). */
  channelCode?: string | undefined;
}

/**
 * POST order: create an order for the partner. Pricing and stock are authoritatively
 * handled by the commerce plugin; the order is marked PAID (partners are prepaid)
 * and the store plugin's existing subscription drives fulfillment.
 */
export async function createOrder(
  ops: CommerceOperations,
  partner: PartnerRecord,
  input: SpOrderInput,
): Promise<unknown> {
  const userId = await resolvePartnerUser(partner);
  const channelCode = `SP_V1:${partner.keyId}${input.channelCode ? `:${input.channelCode}` : ''}`;
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

/** GET order by id, scoped to the partner's linked user. */
export async function getOrder(
  ops: CommerceOperations,
  partner: PartnerRecord,
  id: string,
): Promise<unknown> {
  const userId = await resolvePartnerUser(partner);
  const order = await ops.getOrder(userId, id);
  if (!order) throw new MappingError(404, 'sp_v1.order_not_found', '订单不存在');
  return { order: orderView(order) };
}

/** GET orders for the partner (newest first). */
export async function listOrders(
  ops: CommerceOperations,
  partner: PartnerRecord,
  page = 1,
  pageSize = 20,
): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
  const userId = await resolvePartnerUser(partner);
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

/** Extract the SP order-creation line items (keeps the historical `unit` field). */
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

/** GET services for the partner's linked user. */
export async function listServices(
  ops: CommerceOperations,
  partner: PartnerRecord,
): Promise<{ items: unknown[] }> {
  const userId = await resolvePartnerUser(partner);
  const services = await ops.listServices(userId);
  return { items: services.map(serviceView) };
}

/** GET one service, scoped to the partner. */
export async function getService(
  ops: CommerceOperations,
  partner: PartnerRecord,
  id: string,
): Promise<unknown> {
  const userId = await resolvePartnerUser(partner);
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

/** Run a lifecycle action via the commerce outlet's fulfillment provider. */
export async function runServiceLifecycle(
  ops: CommerceOperations,
  partner: PartnerRecord,
  id: string,
  action: ServiceLifecycleAction,
): Promise<{ service: unknown }> {
  const userId = await resolvePartnerUser(partner);
  const service = await ops.runServiceLifecycle(userId, id, action);
  if (!service) throw new MappingError(404, 'sp_v1.service_not_found', '交付物不存在');
  return { service: serviceView(service) };
}
