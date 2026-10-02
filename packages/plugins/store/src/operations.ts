import type {
  CommerceCatalogQuery,
  CommerceList,
  CommerceOperations,
  CommerceOrder,
  CommerceOrderInput,
  CommerceProduct,
  CommerceService,
  CommerceServiceAction,
  CommerceServiceInput,
  CommerceServicePatch,
} from '@stackpanel/sdk';
import { CommerceError } from '@stackpanel/sdk';
import { bus } from './context';
import { applyServiceLifecycleAction } from './fulfillment';
import type { OrderRecord, ProductRecord, ServiceInstanceRecord } from './repository';
import {
  createOrderInstance,
  createServiceInstance,
  deleteServiceInstance,
  findOrderForUser,
  getProduct,
  getService,
  listActiveProductsPage,
  listOrdersForUserPage,
  listServicesByUser,
  replaceServiceInstance,
  reserveProductStock,
} from './repository';
import type { StoreServiceInstanceData } from './data';

/**
 * 商业域操作的内核出口实现（`EXTENSION_POINTS.commerce`，见 SDK `commerce.ts`）。
 *
 * 商品 / 订单 / 交付物的业务真值归本插件；内核（SP v1 出口、管理端）不再直读
 * 这些表，统一经此契约调用。计价与扣库存沿用插件既有规则，保证与站内下单同源。
 */

/** 与站内下单一致的金额上限（最小货币单位）。 */
const MAX_MINOR_AMOUNT = 2_000_000_000;
const MAX_SERVICES = 200;

const toCommerceProduct = (product: ProductRecord): CommerceProduct => ({
  id: product.id,
  name: product.name,
  description: product.description,
  price: product.price,
  currency: product.currency,
  stock: product.stock,
  status: product.status,
  categoryId: product.categoryId,
  fulfillmentType: product.fulfillmentType,
  providerId: product.providerId,
  providerProductId: product.providerProductId,
  metadata: product.metadata,
  createdAt: product.createdAt,
});

const toCommerceOrder = (order: OrderRecord): CommerceOrder => ({
  id: order.id,
  userId: order.userId,
  items: order.items,
  total: order.total,
  currency: order.currency,
  status: order.status,
  channelCode: order.channelCode,
  createdAt: order.createdAt,
});

const toCommerceService = (service: ServiceInstanceRecord): CommerceService => ({
  id: service.id,
  userId: service.userId,
  orderId: service.orderId,
  productId: service.productId,
  productName: service.productName,
  fulfillmentType: service.fulfillmentType,
  providerId: service.providerId,
  providerServiceId: service.providerServiceId,
  status: service.status,
  credentialsRef: service.credentialsRef,
  runtime: service.runtime,
  amount: service.amount,
  currency: service.currency,
  expiresAt: service.expiresAt,
  provisionedAt: service.provisionedAt,
  terminatedAt: service.terminatedAt,
  createdAt: service.createdAt,
});

const isoOrNull = (value: Date | null): string | null => (value ? value.toISOString() : null);

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

export const storeOperations: CommerceOperations = {
  id: 'store',

  async listCatalog(query: CommerceCatalogQuery): Promise<CommerceList<CommerceProduct>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? 20)));
    const { items, total } = await listActiveProductsPage(
      page,
      pageSize,
      query.categoryId ?? undefined,
    );
    return { items: items.map(toCommerceProduct), total, page, pageSize };
  },

  async getCatalogItem(id: string): Promise<CommerceProduct | null> {
    const product = await getProduct(id);
    if (!product || product.status !== 'ACTIVE') return null;
    return toCommerceProduct(product);
  },

  async createOrder(input: CommerceOrderInput): Promise<CommerceOrder> {
    const quantity = Math.max(1, Math.min(100, Math.trunc(input.quantity)));
    const product = await getProduct(input.productId);
    if (!product || product.status !== 'ACTIVE') {
      throw new CommerceError('product_unavailable', '商品不可用或库存不足');
    }
    const total = product.price * quantity;
    if (!Number.isSafeInteger(total) || total < 1 || total > MAX_MINOR_AMOUNT) {
      throw new CommerceError('amount_invalid', '订单金额无效');
    }
    const reserved = await reserveProductStock(product.id, quantity);
    if (!reserved) {
      throw new CommerceError('product_unavailable', '商品不可用或库存不足');
    }
    const order = await createOrderInstance({
      userId: input.userId,
      items: { items: [{ productId: product.id, quantity, price: product.price, name: product.name }] },
      total,
      currency: product.currency,
      channelCode: input.channelCode ?? null,
      settlementCurrency: product.currency,
      settlementTotal: total,
      fxRate: null,
      state: 'PAID',
    });
    bus().publish('order.paid', { orderId: order.id, channelCode: order.channelCode });
    return toCommerceOrder(order);
  },

  async getOrder(userId: string, id: string): Promise<CommerceOrder | null> {
    const order = await findOrderForUser(id, userId);
    return order ? toCommerceOrder(order) : null;
  },

  async listOrders(userId: string, page: number, pageSize: number): Promise<CommerceList<CommerceOrder>> {
    const current = Math.max(1, Math.trunc(page));
    const size = Math.min(100, Math.max(1, Math.trunc(pageSize)));
    const { items, total } = await listOrdersForUserPage(userId, current, size);
    return { items: items.map(toCommerceOrder), total, page: current, pageSize: size };
  },

  async listServices(userId: string): Promise<CommerceService[]> {
    const services = await listServicesByUser(userId);
    return services.slice(0, MAX_SERVICES).map(toCommerceService);
  },

  async getService(userId: string, id: string): Promise<CommerceService | null> {
    const service = await getService(id);
    return service && service.userId === userId ? toCommerceService(service) : null;
  },

  async runServiceLifecycle(
    userId: string,
    id: string,
    action: CommerceServiceAction,
  ): Promise<CommerceService | null> {
    const service = await getService(id);
    if (!service || service.userId !== userId) return null;
    await applyServiceLifecycleAction(service, action);
    const nextStatus =
      action === 'suspend' ? 'SUSPENDED' : action === 'resume' ? 'ACTIVE' : 'TERMINATED';
    await replaceServiceInstance(service.id, toServiceData({
      ...service,
      status: nextStatus,
      terminatedAt: action === 'terminate' ? new Date() : service.terminatedAt,
    }));
    const updated = await getService(service.id);
    return updated ? toCommerceService(updated) : null;
  },

  async listActiveProducts(limit: number): Promise<CommerceProduct[]> {
    const size = Math.min(MAX_SERVICES, Math.max(1, Math.trunc(limit)));
    const { items } = await listActiveProductsPage(1, size);
    return items.map(toCommerceProduct);
  },

  async createServices(input: CommerceServiceInput): Promise<CommerceService[]> {
    const product = await getProduct(input.productId);
    if (!product) throw new CommerceError('product_not_found', '商品不存在');
    if (product.status !== 'ACTIVE') {
      throw new CommerceError('product_unavailable', '商品已停售，无法赠送');
    }
    const count = Math.max(1, Math.min(100, Math.trunc(input.quantity)));
    const expiresAt = input.expiresAt ? input.expiresAt.toISOString() : null;
    const created: CommerceService[] = [];
    for (let index = 0; index < count; index += 1) {
      const service = await createServiceInstance({
        userId: input.userId,
        orderId: null,
        productId: product.id,
        productName: product.name,
        fulfillmentType: product.fulfillmentType,
        providerId: product.providerId,
        providerServiceId: null,
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: product.price,
        currency: product.currency,
        provisionedAt: new Date().toISOString(),
        expiresAt,
      });
      created.push(toCommerceService(service));
    }
    return created;
  },

  async updateService(id: string, patch: CommerceServicePatch): Promise<CommerceService | null> {
    const service = await getService(id);
    if (!service) return null;
    await replaceServiceInstance(id, toServiceData({
      ...service,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
    }));
    const updated = await getService(id);
    return updated ? toCommerceService(updated) : null;
  },

  async deleteService(id: string): Promise<boolean> {
    const service = await getService(id);
    if (!service) return false;
    await deleteServiceInstance(id);
    return true;
  },
};
