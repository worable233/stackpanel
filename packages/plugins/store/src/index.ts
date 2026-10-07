import type { AdminDashboardWidgetMeta, HttpReply, HttpRequest, NavItem } from '@stackpanel/sdk';
import { EXTENSION_POINTS, definePlugin, PluginError } from '@stackpanel/sdk';
import { bindContext, context, resetContext } from './context';
import { StoreError } from './errors';
import {
  settlementHandler,
  createOrder,
  checkoutCart,
  listMyOrders,
  cancelOrder,
  listAdminOrders,
} from './orders';
import {
  createProduct,
  createProductForSync,
  deleteProduct,
  getProduct,
  getProductById,
  listAdminProducts,
  listAllProducts,
  listProducts,
  listProductsByIds,
  removeProductForSync,
  updateProduct,
  updateProductForSync,
  updateProductStock,
} from './products';
import type { StoreProductRead, StoreProductUpdate } from './products';
import { addToCart, listCart, removeCartItem, updateCartQuantity } from './cart';
import {
  getMyService,
  getMyServiceMetrics,
  listAdminDeliveryTasks,
  listAdminServices,
  listMyServices,
  retryAdminDeliveryTask,
  runMyServiceAction,
  FULFILLMENT_POLL_INTERVAL_MS,
  processDue,
  subscribeOrderPaid,
} from './fulfillment';
import { createCategory, deleteCategory, listCategories, updateCategory } from './categories';
import { storeOperations } from './operations';
import {
  getUpstreamProduct,
  listProductTypes,
  listUpstreamSources,
  searchUpstreamProducts,
} from './product-types';
import { calculateProductPrice } from './pricing';
import {
  cartItemModel,
  categoryModel,
  deliveryTaskModel,
  orderModel,
  productModel,
  serviceInstanceModel,
} from './data';

const STORE_PRODUCT_READ = 'store.product.read';
const STORE_PRODUCT_UPDATE = 'store.product.update';

const NAV_ITEMS: NavItem[] = [{ surface: 'public', label: '选购', href: '/shop' }];

function handle(handler: (req: HttpRequest, reply: HttpReply) => Promise<unknown>) {
  return async (req: HttpRequest, reply: HttpReply): Promise<unknown> => {
    try {
      return await handler(req, reply);
    } catch (error) {
      // Deterministic errors become problem+json with a stable code; the kernel
      // boundary renders them (ADR-0012 §5).
      if (error instanceof StoreError) {
        throw new PluginError(error.code, error.status, error.message);
      }
      // Kernel-domain errors (PaymentError/WalletError/…) are already branded
      // deterministic errors, so the boundary renders their code + provider
      // reason directly. Do not rewrite them into a generic store code.
      throw error;
    }
  };
}

const listPaymentMethods = async (): Promise<unknown> => context().payments.listPaymentMethods();

const listChannelMethods = async (req: HttpRequest): Promise<unknown> => {
  const code = req.params['code'];
  if (!code) throw new StoreError(400, '渠道编码无效');
  const channel = await context().payments.listChannelMethods(code);
  if (!channel || !channel.enabled) throw new StoreError(404, '销售渠道不存在或未启用');
  const methods = channel.methods
    .filter((method) => method.enabled !== false)
    .map((method) => ({
      id: method.id,
      providerId: method.providerId,
      name: method.name,
      scene: method.scene,
    }));
  return { channel: { code: channel.code, name: channel.name }, methods };
};

export const storePlugin = definePlugin({
  manifest: {
    id: 'store',
    name: '商店插件',
    version: '0.3.0',
    description: '商品、购物车与订单。',
    provides: [
      EXTENSION_POINTS.paymentSettlement,
      EXTENSION_POINTS.commerce,
      STORE_PRODUCT_READ,
      STORE_PRODUCT_UPDATE,
    ],
    permissions: [
      { key: 'store.view', name: '浏览商店', description: '浏览商品与分类等商店前台内容。' },
      { key: 'store.buy', name: '购买商品', description: '下单购买商品并完成支付。' },
      {
        key: 'store.admin',
        name: '管理商店',
        description: '管理商品、订单与支付渠道等商店后台。',
      },
    ],
    roleTemplates: [
      { role: 'USER', permissions: ['store.view', 'store.buy'] },
      { role: 'ADMIN', permissions: ['store.admin'] },
    ],
    capabilities: [
      {
        id: 'store.products.list',
        method: 'GET',
        route: '/products',
        path: '/api/v1/store/products',
        summary: 'List active products',
      },
      {
        id: 'store.product.read',
        method: 'GET',
        route: '/products/:id',
        path: '/api/v1/store/products/:id',
        summary: 'Read one product by id',
      },
      {
        id: 'store.orders.list',
        method: 'GET',
        route: '/orders',
        path: '/api/v1/store/orders',
        summary: "The caller's own orders",
      },
    ],
  },

  customModels: [
    productModel,
    categoryModel,
    cartItemModel,
    orderModel,
    serviceInstanceModel,
    deliveryTaskModel,
  ],

  routes: [
    { method: 'GET', path: '/products', auth: 'public', handler: handle(listProducts) },
    { method: 'GET', path: '/products/:id', auth: 'public', handler: handle(getProduct) },
    {
      method: 'GET',
      path: '/payment-methods',
      auth: 'public',
      handler: handle(listPaymentMethods),
    },
    {
      method: 'GET',
      path: '/channels/:code/methods',
      auth: 'public',
      handler: handle(listChannelMethods),
    },
    {
      method: 'POST',
      path: '/orders',
      auth: 'user',
      permission: 'store.buy',
      handler: handle((req) => createOrder(context(), req)),
    },
    {
      method: 'POST',
      path: '/cart/checkout',
      auth: 'user',
      permission: 'store.buy',
      handler: handle((req) => checkoutCart(context(), req)),
    },
    {
      method: 'GET',
      path: '/cart',
      auth: 'user',
      permission: 'store.view',
      handler: handle(listCart),
    },
    {
      method: 'POST',
      path: '/cart/items',
      auth: 'user',
      permission: 'store.buy',
      handler: handle(addToCart),
    },
    {
      method: 'PATCH',
      path: '/cart/items/:id',
      auth: 'user',
      permission: 'store.buy',
      handler: handle(updateCartQuantity),
    },
    {
      method: 'DELETE',
      path: '/cart/items/:id',
      auth: 'user',
      permission: 'store.buy',
      handler: handle(removeCartItem),
    },
    {
      method: 'GET',
      path: '/orders',
      auth: 'user',
      permission: 'store.view',
      handler: handle(listMyOrders),
    },
    {
      method: 'POST',
      path: '/orders/:id/cancel',
      auth: 'user',
      permission: 'store.buy',
      handler: handle((req) => cancelOrder(context(), req)),
    },
    {
      method: 'GET',
      path: '/store/admin/products',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(listAdminProducts),
    },
    {
      method: 'POST',
      path: '/store/admin/products',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(createProduct),
    },
    {
      method: 'PATCH',
      path: '/store/admin/products/:id',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(updateProduct),
    },
    {
      method: 'DELETE',
      path: '/store/admin/products/:id',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(deleteProduct),
    },
    {
      method: 'GET',
      path: '/store/admin/orders',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(listAdminOrders),
    },
    // 分类
    { method: 'GET', path: '/categories', auth: 'public', handler: handle(listCategories) },
    {
      method: 'POST',
      path: '/store/admin/categories',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(createCategory),
    },
    {
      method: 'PATCH',
      path: '/store/admin/categories/:id',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(updateCategory),
    },
    {
      method: 'DELETE',
      path: '/store/admin/categories/:id',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(deleteCategory),
    },
    // 用户「我的服务」
    {
      method: 'GET',
      path: '/services',
      auth: 'user',
      permission: 'store.view',
      handler: handle(listMyServices),
    },
    {
      method: 'GET',
      path: '/services/:id',
      auth: 'user',
      permission: 'store.view',
      handler: handle(getMyService),
    },
    {
      method: 'GET',
      path: '/services/:id/metrics',
      auth: 'user',
      permission: 'store.view',
      handler: handle(getMyServiceMetrics),
    },
    {
      method: 'POST',
      path: '/services/:id/actions',
      auth: 'user',
      permission: 'store.view',
      handler: handle(runMyServiceAction),
    },
    // 商品类型 + 上游关联（商品表单用）
    {
      method: 'GET',
      path: '/products/:id',
      auth: 'public',
      handler: handle(getProduct),
    },
    {
      method: 'POST',
      path: '/store/products/:id/price',
      auth: 'public',
      handler: handle(calculateProductPrice),
    },
    {
      method: 'GET',
      path: '/store/product-types',
      auth: 'public',
      handler: handle(listProductTypes),
    },
    {
      method: 'GET',
      path: '/store/upstream-sources',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(listUpstreamSources),
    },
    {
      method: 'GET',
      path: '/store/upstream-products/:provider',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(searchUpstreamProducts),
    },
    {
      method: 'GET',
      path: '/store/upstream-products/:provider/:productId',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(getUpstreamProduct),
    },
    // 管理端：履约任务与交付物
    {
      method: 'GET',
      path: '/store/admin/delivery-tasks',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(listAdminDeliveryTasks),
    },
    {
      method: 'POST',
      path: '/store/admin/delivery-tasks/:id/retry',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(retryAdminDeliveryTask),
    },
    {
      method: 'GET',
      path: '/store/admin/services',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(listAdminServices),
    },
  ],
  onActivate: (ctx) => {
    // 上下文绑定本身也是可逆副作用：停用时逆序回卷 —— 先撤订阅/调度器，再清上下文。
    ctx.effect(() => {
      bindContext(ctx);
      return resetContext;
    });
    for (const item of NAV_ITEMS) ctx.registerExtension<NavItem>(EXTENSION_POINTS.webNav, item);
    ctx.registerExtension(EXTENSION_POINTS.paymentSettlement, settlementHandler);
    ctx.registerExtension(EXTENSION_POINTS.commerce, storeOperations);
    ctx.registerExtension<AdminDashboardWidgetMeta>(EXTENSION_POINTS.adminDashboard, {
      id: 'store-summary',
      title: '商店概览',
      description: '商品、订单与支付渠道。',
    });
    ctx.registerExtension<StoreProductRead>(STORE_PRODUCT_READ, {
      listAll: listAllProducts,
      listByIds: listProductsByIds,
      getById: getProductById,
    });
    ctx.registerExtension<StoreProductUpdate>(STORE_PRODUCT_UPDATE, {
      updateStock: updateProductStock,
      create: createProductForSync,
      update: updateProductForSync,
      remove: removeProductForSync,
    });
    // 履约体系：付款后异步交付 + 队列轮询。轮询改为内核任务（ctx.jobs），
    // 集群下只由一个 worker 执行，不再每副本各起一个定时器。
    ctx.effect(() => subscribeOrderPaid());
    ctx.jobs.handle('fulfillment-poll', async () => {
      await processDue();
    });
    ctx.jobs.schedule('fulfillment-poll', { everyMs: FULFILLMENT_POLL_INTERVAL_MS });
    ctx.logger.info('store: activated');
  },
  onDeactivate: (ctx) => {
    ctx.logger.info('store: deactivated');
  },
});

export default storePlugin;
