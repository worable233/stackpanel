import type {
  AdminDashboardWidgetMeta,
  HttpReply,
  HttpRequest,
  JobContext,
  NavItem,
} from '@stackpanel/sdk';
import { EXTENSION_POINTS, definePlugin, PluginError } from '@stackpanel/sdk';
import { bindContext, context, resetContext } from './context';
import { StoreError } from './errors';
import { storeSettings, saveStoreSettings } from './settings';
import { approveAdminDeliveryTask, reconcileProvisioning, reconcileAdminDeliveryTask, listAdminReconciliationCandidates, resumeAdminDeliveryPayment, recoverAdminDeliveryTask } from './fulfillment';
import {
  settlementHandler,
  createOrder,
  checkoutCart,
  listMyOrders,
  getMyOrder,
  cancelOrder,
  listAdminOrders,
  recycleMyOrder,
  restoreRecycledOrder,
  purgeRecycledNow,
} from './orders';
import { ORDER_PURGE_INTERVAL_MS, purgeRecycledOrders } from './recycle';
import {
  createProduct,
  createProductForSync,
  deleteProduct,
  getProduct,
  getProductById,
  getPurchasableProduct,
  listAdminProducts,
  listAllProducts,
  listProducts,
  listProductsByIds,
  listPurchasableProducts,
  removeProductForSync,
  updateProduct,
  updateProductForSync,
  updateProductStock,
} from './products';
import type { StoreProductRead, StoreProductUpdate } from './products';
import { addToCart, listCart, removeCartItem, updateCartQuantity } from './cart';
import { withIdempotency } from './idempotency';
import {
  getMyService,
  getMyServiceMetrics,
  listAdminDeliveryTasks,
  listAdminServices,
  listMyServices,
  listMyServiceResourceKinds,
  listMyServiceResources,
  createMyServiceResource,
  runMyServiceResourceAction,
  retryAdminDeliveryTask,
  runMyServiceAction,
  FULFILLMENT_POLL_INTERVAL_MS,
  processDue,
  subscribeOrderPaid,
} from './fulfillment';
import { createCategory, deleteCategory, listCategories, updateCategory } from './categories';
import { storeOperations } from './operations';
import { renewService } from './renewal';
import { STORE_NOTIFICATION_TYPES } from './notifications';
import { changeService, quoteServiceChange, transferService } from './changes';
import { refundOrder, createRefundRequest, listRefundRequests, reviewRefundRequest } from './refund';
import { runExpirySweep, EXPIRY_SWEEP_INTERVAL_MS } from './expiry';
import {
  getUpstreamProduct,
  getUpstreamProductConfig,
  listProductTypes,
  listUpstreamSources,
  searchUpstreamProducts,
} from './product-types';
import { calculateProductPrice } from './pricing';
import { listCurrencyIssues, normalizeLegacyProductCurrencies } from './currency-migration';
import {
  cartItemModel,
  categoryModel,
  deliveryTaskModel,
  orderModel,
  productModel,
  serviceInstanceModel,
  refundRequestModel,
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

/**
 * 本插件注册的内核任务。
 *
 * 抽成独立函数是为了让 `jobs-contract.test.ts` 能直接调用它断言名字与频率 ——
 * `REF-定时任务与幂等契约.md` §3 的清单同样不能靠「文档写着」来维持。
 */
export function registerStoreJobs(jobs: JobContext): void {
  // 履约体系：付款后异步交付 + 队列轮询。集群下只由一个 worker 执行，
  // 不再每副本各起一个定时器。
  jobs.handle('fulfillment-poll', async () => {
    await processDue();
    await reconcileProvisioning();
  });
  void jobs.schedule('fulfillment-poll', { everyMs: FULFILLMENT_POLL_INTERVAL_MS });

  // 到期自动化：提醒 →（宽限期）→ 暂停 →（保留期）→ 终止。集群下单次执行。
  jobs.handle('expiry-sweep', async () => {
    await runExpirySweep();
  });
  void jobs.schedule('expiry-sweep', { everyMs: EXPIRY_SWEEP_INTERVAL_MS });

  // 回收站清理：超过保留期的未支付订单真删。
  jobs.handle('order-purge', async () => {
    await purgeRecycledOrders();
  });
  void jobs.schedule('order-purge', { everyMs: ORDER_PURGE_INTERVAL_MS });
}

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
      'platform.admin',
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
        id: 'store.account.products.list',
        method: 'GET',
        route: '/store/account/products',
        path: '/api/v1/store/account/products',
        summary: "Purchasable products for the authenticated user's catalog",
      },
      {
        id: 'store.account.product.read',
        method: 'GET',
        route: '/store/account/products/:id',
        path: '/api/v1/store/account/products/:id',
        summary: 'Read one purchasable product for the account store',
      },
      {
        id: 'store.orders.list',
        method: 'GET',
        route: '/orders',
        path: '/api/v1/store/orders',
        summary: "The caller's own orders",
      },
      {
        id: 'store.admin.products.list',
        method: 'GET',
        route: '/store/admin/products',
        path: '/api/v1/store/admin/products',
        summary: 'List all products for administration',
      },
      {
        id: 'store.admin.currencyIssues',
        method: 'GET',
        route: '/store/admin/currency-issues',
        path: '/api/v1/store/admin/currency-issues',
        summary: 'Products withheld by the legacy currency migration',
      },
      {
        id: 'store.admin.products.create',
        method: 'POST',
        route: '/store/admin/products',
        path: '/api/v1/store/admin/products',
        summary: 'Create a product',
        mutating: true,
      },
      {
        id: 'store.admin.products.update',
        method: 'PATCH',
        route: '/store/admin/products/:id',
        path: '/api/v1/store/admin/products/:id',
        summary: 'Update a product',
        mutating: true,
      },
      {
        id: 'store.admin.products.delete',
        method: 'DELETE',
        route: '/store/admin/products/:id',
        path: '/api/v1/store/admin/products/:id',
        summary: 'Delete a product',
        mutating: true,
      },
      {
        id: 'store.admin.orders.list',
        method: 'GET',
        route: '/store/admin/orders',
        path: '/api/v1/store/admin/orders',
        summary: 'List all orders for administration',
      },
      {
        id: 'store.admin.orders.refund',
        method: 'POST',
        route: '/store/admin/orders/:id/refund',
        path: '/api/v1/store/admin/orders/:id/refund',
        summary: 'Refund an order (full or partial)',
        mutating: true,
      },
      {
        id: 'store.admin.categories.create',
        method: 'POST',
        route: '/store/admin/categories',
        path: '/api/v1/store/admin/categories',
        summary: 'Create a category',
        mutating: true,
      },
      {
        id: 'store.admin.categories.update',
        method: 'PATCH',
        route: '/store/admin/categories/:id',
        path: '/api/v1/store/admin/categories/:id',
        summary: 'Update a category',
        mutating: true,
      },
      {
        id: 'store.admin.categories.delete',
        method: 'DELETE',
        route: '/store/admin/categories/:id',
        path: '/api/v1/store/admin/categories/:id',
        summary: 'Delete a category',
        mutating: true,
      },
      {
        id: 'store.admin.deliveryTasks.list',
        method: 'GET',
        route: '/store/admin/delivery-tasks',
        path: '/api/v1/store/admin/delivery-tasks',
        summary: 'List delivery tasks for administration',
      },
      {
        id: 'store.admin.deliveryTasks.retry',
        method: 'POST',
        route: '/store/admin/delivery-tasks/:id/retry',
        path: '/api/v1/store/admin/delivery-tasks/:id/retry',
        summary: 'Retry a failed delivery task',
        mutating: true,
      },
      {
        id: 'store.admin.services.list',
        method: 'GET',
        route: '/store/admin/services',
        path: '/api/v1/store/admin/services',
        summary: 'List all delivered services for administration',
      },
      {
        id: 'store.services.resources.kinds',
        method: 'GET',
        route: '/services/:id/resource-kinds',
        path: '/api/v1/store/services/:id/resource-kinds',
        summary: "A service's available value-added resource kinds",
      },
      {
        id: 'store.services.resources.list',
        method: 'GET',
        route: '/services/:id/resources/:kind',
        path: '/api/v1/store/services/:id/resources/:kind',
        summary: 'List a service sub-resource set (disks/snapshots/backups/…)',
      },
      {
        id: 'store.services.resources.create',
        method: 'POST',
        route: '/services/:id/resources/:kind',
        path: '/api/v1/store/services/:id/resources/:kind',
        summary: 'Create a service sub-resource',
        mutating: true,
      },
      {
        id: 'store.services.resources.action',
        method: 'POST',
        route: '/services/:id/resources/:kind/:resourceId/actions/:actionId',
        path: '/api/v1/store/services/:id/resources/:kind/:resourceId/actions/:actionId',
        summary: 'Run an action on a service sub-resource',
        mutating: true,
      },
      {
        id: 'store.services.change.quote',
        method: 'POST',
        route: '/services/:id/change-quote',
        path: '/api/v1/store/services/:id/change-quote',
        summary: 'Quote the price difference for an upgrade/downgrade',
      },
      {
        id: 'store.services.change',
        method: 'POST',
        route: '/services/:id/change',
        path: '/api/v1/store/services/:id/change',
        summary: 'Order an upgrade/downgrade/product change',
        mutating: true,
      },
      {
        id: 'store.admin.services.transfer',
        method: 'POST',
        route: '/store/admin/services/:id/transfer',
        path: '/api/v1/store/admin/services/:id/transfer',
        summary: 'Transfer a service to another user',
        mutating: true,
      },
      {
        id: 'store.admin.productTypes.list',
        method: 'GET',
        route: '/store/product-types',
        path: '/api/v1/store/product-types',
        summary: 'List registered product types (with config field declarations)',
      },
      {
        id: 'store.admin.upstreamSources.list',
        method: 'GET',
        route: '/store/upstream-sources',
        path: '/api/v1/store/upstream-sources',
        summary: 'List registered upstream product sources',
      },
      {
        id: 'store.admin.upstreamProducts.search',
        method: 'GET',
        route: '/store/upstream-products/:provider',
        path: '/api/v1/store/upstream-products/:provider',
        summary: 'Search a provider\u2019s upstream products',
      },
      {
        id: 'store.admin.upstreamProducts.get',
        method: 'GET',
        route: '/store/upstream-products/:provider/:productId',
        path: '/api/v1/store/upstream-products/:provider/:productId',
        summary: 'Read one upstream product',
      },
      {
        id: 'store.admin.upstreamProducts.config',
        method: 'GET',
        route: '/store/upstream-products/:provider/:productId/config',
        path: '/api/v1/store/upstream-products/:provider/:productId/config',
        summary: 'Read an upstream product\u2019s checkout configuration for auto-fill',
      },
      {
        id: 'store.admin.categories.list',
        method: 'GET',
        route: '/categories',
        path: '/api/v1/store/categories',
        summary: 'List categories',
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
    refundRequestModel,
  ],

  routes: [
    { method: 'GET', path: '/store/admin/settings', auth: 'admin', permission: 'platform.admin', handler: handle(storeSettings) },
    { method: 'POST', path: '/store/admin/settings', auth: 'admin', permission: 'platform.admin', handler: handle(saveStoreSettings) },
    { method: 'POST', path: '/store/admin/delivery-tasks/:id/approve', auth: 'admin', permission: 'store.admin', handler: handle(approveAdminDeliveryTask) },
    { method: 'POST', path: '/orders/:id/refund-requests', auth: 'user', permission: 'store.buy', handler: handle(createRefundRequest) },
    { method: 'GET', path: '/refund-requests', auth: 'user', permission: 'store.view', handler: handle((req) => listRefundRequests(req, false)) },
    { method: 'GET', path: '/store/admin/refund-requests', auth: 'admin', permission: 'store.admin', handler: handle((req) => listRefundRequests(req, true)) },
    { method: 'POST', path: '/store/admin/refund-requests/:id/review', auth: 'admin', permission: 'store.admin', handler: handle(reviewRefundRequest) },
    { method: 'GET', path: '/products', auth: 'public', handler: handle(listProducts) },
    { method: 'GET', path: '/products/:id', auth: 'public', handler: handle(getProduct) },
    // 账户商城：登录用户的可购买目录与详情（返回 PurchasableProduct）。
    {
      method: 'GET',
      path: '/store/account/products',
      auth: 'user',
      permission: 'store.view',
      handler: handle(listPurchasableProducts),
    },
    {
      method: 'GET',
      path: '/store/account/products/:id',
      auth: 'user',
      permission: 'store.view',
      handler: handle(getPurchasableProduct),
    },
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
      handler: handle((req) =>
        withIdempotency(req, 'order.create', () => createOrder(context(), req)),
      ),
    },
    {
      method: 'POST',
      path: '/cart/checkout',
      auth: 'user',
      permission: 'store.buy',
      handler: handle((req) =>
        withIdempotency(req, 'cart.checkout', () => checkoutCart(context(), req)),
      ),
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
      method: 'GET',
      path: '/orders/:id',
      auth: 'user',
      permission: 'store.view',
      handler: handle(getMyOrder),
    },
    {
      method: 'POST',
      path: '/orders/:id/cancel',
      auth: 'user',
      permission: 'store.buy',
      handler: handle((req) => cancelOrder(context(), req)),
    },
    // 未支付订单回收站（#12.1）：软删 / 管理员恢复 / 管理员当场清理。
    // 删除权限用 store.view（用户看得到自己的订单列表就能整理它）；恢复与
    // 清理是管理动作，走 store.admin。
    {
      method: 'DELETE',
      path: '/orders/:id',
      auth: 'user',
      permission: 'store.view',
      handler: handle(recycleMyOrder),
    },
    {
      method: 'POST',
      path: '/store/admin/orders/:id/restore',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(restoreRecycledOrder),
    },
    {
      method: 'POST',
      path: '/store/admin/orders/purge-recycled',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(purgeRecycledNow),
    },
    {
      method: 'GET',
      path: '/store/admin/products',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(listAdminProducts),
    },
    {
      method: 'GET',
      path: '/store/admin/currency-issues',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(async () => ({ issues: await listCurrencyIssues() })),
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
    // 退款：已支付订单退回用户钱包（管理端）
    {
      method: 'POST',
      path: '/store/admin/orders/:id/refund',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(refundOrder),
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
    // 增值运维：服务子资源（磁盘/快照/备份/网络/流量包…）
    {
      method: 'GET',
      path: '/services/:id/resource-kinds',
      auth: 'user',
      permission: 'store.view',
      handler: handle(listMyServiceResourceKinds),
    },
    {
      method: 'GET',
      path: '/services/:id/resources/:kind',
      auth: 'user',
      permission: 'store.view',
      handler: handle(listMyServiceResources),
    },
    {
      method: 'POST',
      path: '/services/:id/resources/:kind',
      auth: 'user',
      permission: 'store.buy',
      handler: handle(createMyServiceResource),
    },
    {
      method: 'POST',
      path: '/services/:id/resources/:kind/:resourceId/actions/:actionId',
      auth: 'user',
      permission: 'store.buy',
      handler: handle(runMyServiceResourceAction),
    },
    // 升配/降配/换商品
    {
      method: 'POST',
      path: '/services/:id/change-quote',
      auth: 'user',
      permission: 'store.view',
      handler: handle(quoteServiceChange),
    },
    {
      method: 'POST',
      path: '/services/:id/change',
      auth: 'user',
      permission: 'store.buy',
      handler: handle((req) =>
        withIdempotency(req, 'service.change', () => changeService(context(), req)),
      ),
    },
    // 续费：针对已购服务再下一单（支付成功后顺延到期时间）
    {
      method: 'POST',
      path: '/services/:id/renew',
      auth: 'user',
      permission: 'store.buy',
      handler: handle((req) =>
        withIdempotency(req, 'service.renew', () => renewService(context(), req)),
      ),
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
      // 匿名可试算（只有商品折扣），登录后按权限组折扣计价 —— 与下单同源。
      auth: 'optional',
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
    {
      method: 'GET',
      path: '/store/upstream-products/:provider/:productId/config',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(getUpstreamProductConfig),
    },
    // 管理端：履约任务与交付物
    {
      method: 'POST', path: '/store/admin/delivery-tasks/:id/recover',
      auth: 'admin', permission: 'store.admin', handler: handle(recoverAdminDeliveryTask),
    },
    {
      method: 'POST', path: '/store/admin/delivery-tasks/:id/resume-payment',
      auth: 'admin', permission: 'store.admin', handler: handle(resumeAdminDeliveryPayment),
    },
    {
      method: 'GET',
      path: '/store/admin/delivery-tasks/:id/candidates',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(listAdminReconciliationCandidates),
    },
    {
      method: 'POST',
      path: '/store/admin/delivery-tasks/:id/reconcile',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(reconcileAdminDeliveryTask),
    },
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
    // 产品转移（管理端，走审批流）
    {
      method: 'POST',
      path: '/store/admin/services/:id/transfer',
      auth: 'admin',
      permission: 'store.admin',
      handler: handle(transferService),
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
    // 声明本插件发出的通知类型，供内核偏好目录展示（未声明不可关闭）。
    for (const def of STORE_NOTIFICATION_TYPES) {
      ctx.registerExtension(EXTENSION_POINTS.notificationType, def);
    }
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
    // 存量币种修复（plan §6 阶段 4）：一次性的幂等扫描，别名/小写就地规范
    // 化，无法识别的商品停售并记录原因，绝不猜测转换。失败不能阻塞插件启动。
    ctx.effect(() => {
      void normalizeLegacyProductCurrencies().catch((error: unknown) => {
        ctx.logger.warn(`store: currency migration skipped: ${String(error)}`);
      });
    });
    ctx.effect(() => subscribeOrderPaid());
    registerStoreJobs(ctx.jobs);
    ctx.logger.info('store: activated');
  },
  onDeactivate: (ctx) => {
    ctx.logger.info('store: deactivated');
  },
});

export default storePlugin;
