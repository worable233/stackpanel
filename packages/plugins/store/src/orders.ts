import { WALLET_CURRENCY } from '@stackpanel/sdk';
import type {
  ExtensionTransaction,
  HttpRequest,
  OrderPriceContext,
  PaymentSettlementHandler,
  PluginContext,
  ResolvedPaymentSettlement,
} from '@stackpanel/sdk';
import { bus, context, logger, runTransaction } from './context';
import { stockItems, StoreError } from './errors';
import { removePurchasedCartItems } from './cart';
import {
  cartItemModel,
  orderModel,
  productModel,
  type StoreCartItemData,
  type StoreOrderData,
  type StoreProductData,
} from './data';
import {
  changeOrderState,
  getOrder,
  listAllOrdersPage,
  listOrdersForUserPage,
  findOrderForUser,
  toOrder,
} from './repository';
import {
  checkoutSchema,
  createOrderSchema,
  idSchema,
  MAX_MINOR_AMOUNT,
  orderOptions,
  parseCheckoutSelection,
  parsePagination,
} from './utils';
import { resolveCheckoutPrice, effectiveDiscount } from './pricing';
import { applyDiscount, betterDiscount } from './discount';
import { formatAmountPair, quoteSettlement, sameCurrency } from './currency';
import { notifyUser } from './notifications';
import { sellabilityBlocker } from './fulfillment-diagnostics';

/**
 * Refuse to sell a product that cannot be delivered.
 *
 * `assertCloudServerProvider` guards product *writes*, but data drifts: an
 * operator disables or uninstalls the upstream plugin and the catalog row stays
 * ACTIVE. Taking the money first and discovering the gap during fulfillment
 * produces a PAID order stuck in REQUIRES_RECONCILIATION — the customer has
 * paid, no service exists, and an admin has to unwind it by hand. Check at
 * reserve time, before payment, so the failure costs the customer nothing.
 *
 * Delegates to the same diagnosis the admin panel shows, so the error a buyer
 * hits and the warning an operator sees can never disagree.
 */
export function assertSellableProduct(product: {
  status?: string;
  fulfillmentType: string;
  providerId?: string | null;
}): void {
  const blocker = sellabilityBlocker({
    status: product.status ?? 'ACTIVE',
    fulfillmentType: product.fulfillmentType,
    providerId: product.providerId ?? null,
  });
  if (!blocker) return;
  // Keep the historical message for the cloud-server/no-provider cases: it is
  // asserted by tests and already surfaced in operator docs.
  if (blocker.code === 'NO_PROVIDER') {
    throw new StoreError(400, '云服务器商品必须绑定真实履约提供方');
  }
  throw new StoreError(400, blocker.message);
}
import { auditActor, recordStoreAudit, STORE_AUDIT_ACTIONS } from './audit';

interface OrderLine {
  productId: string;
  quantity: number;
  config?: unknown;
}

interface ResolvedLine {
  productId: string;
  name: string;
  price: number;
  currency: string;
  quantity: number;
  config?: unknown;
  description?: string;
}

interface Reserved {
  resolved: ResolvedLine[];
  total: number;
  orderId: string;
  currency: string;
  settlementCurrency: string;
  settlementTotal: number;
  fxRate: number | null;
}

async function reserve(
  tx: ExtensionTransaction,
  userId: string,
  lines: OrderLine[],
  options: { channelCode?: string; methodId?: string; providerId?: string; paymentMethod?: string },
  discount: number,
): Promise<Reserved> {
  const resolved: ResolvedLine[] = [];
  let total = 0;
  let orderCurrency: string | null = null;
  for (const line of lines) {
    const instance = await tx.extensions.get<StoreProductData>(productModel, line.productId);
    const product = instance?.spec ?? null;
    if (!product || product.status !== 'ACTIVE' || product.stock < line.quantity) {
      throw new StoreError(409, '商品不可用或库存不足');
    }
    /*
     * Refuse to sell a product that cannot be delivered before taking payment.
     */
    assertSellableProduct({ ...product, status: product.status });
    // Enforce a single currency per order: summing amounts of different
    // currencies into one total would be financially incorrect.
    if (orderCurrency !== null && !sameCurrency(product.currency, orderCurrency)) {
      throw new StoreError(409, '订单商品币种不一致，请分开下单');
    }
    orderCurrency = product.currency;
    const config = parseCheckoutSelection(line.config);
    // 折扣计价：商品自身折扣与用户权限组折扣取更优（% off），与展示路径同源。
    const effective = betterDiscount(product.discount, discount);
    let baseUnit = product.price;
    let configSummary: string | undefined;
    {
      const { unit, result } = await resolveCheckoutPrice(
        { id: line.productId, ...product },
        line.quantity,
        config,
      );
      baseUnit = unit;
      configSummary = result?.summary;
    }
    const discountedUnit = applyDiscount(baseUnit, effective);
    // Pricing policy seam: interceptors may rewrite the per-unit price before
    // the order total is computed.
    const unit = bus().waterfall<OrderPriceContext>(
      'store.order.price',
      {
        productId: line.productId,
        quantity: line.quantity,
        currency: product.currency,
        unit: discountedUnit,
      },
      (value) => value,
    ).unit;
    if (!Number.isInteger(unit) || unit < 0) {
      throw new StoreError(400, '订单金额无效');
    }
    if (unit > Math.floor(MAX_MINOR_AMOUNT / line.quantity)) {
      throw new StoreError(400, '订单金额过大');
    }
    total += unit * line.quantity;
    if (total > MAX_MINOR_AMOUNT) throw new StoreError(400, '订单金额过大');
    const { updated } = await tx.extensions.updateWhere(
      productModel,
      { name: { eq: line.productId }, status: { eq: 'ACTIVE' }, stock: { gte: line.quantity } },
      { stock: { dec: line.quantity } },
    );
    if (updated === 0) throw new StoreError(409, '商品不可用或库存不足');
    resolved.push({
      productId: line.productId,
      name: product.name,
      price: unit,
      currency: product.currency,
      quantity: line.quantity,
      ...(config ? { config: config as unknown } : {}),
      ...(configSummary ? { description: configSummary } : {}),
    });
  }
  // Empty carts are rejected elsewhere; if a caller still reaches here without
  // a line, fall back to the platform settlement currency rather than a
  // hard-coded CNY.
  const currency = orderCurrency ?? (await context().fx.getSettlementCurrency());
  // Settlement currency comes from platform settings (never hard-coded CNY).
  // The quote freezes the rate; a missing/expired rate or unsupported
  // settlement currency aborts the order before any stock is consumed.
  const quote = await quoteSettlement(context(), currency, total);
  const created = await tx.extensions.create<StoreOrderData>(orderModel, {
    userId,
    items: { items: resolved },
    total,
    currency,
    state: 'PENDING',
    channelCode: options.channelCode ?? 'MALL_PC',
    settlementCurrency: quote.toCurrency,
    settlementTotal: quote.settlementAmount,
    fxRate: quote.rate ?? null,
  });
  return {
    resolved,
    total,
    orderId: created.name,
    currency,
    settlementCurrency: quote.toCurrency,
    settlementTotal: quote.settlementAmount,
    fxRate: quote.rate,
  };
}

async function removeCartInTx(
  tx: ExtensionTransaction,
  userId: string,
  cart?: { cartItemIds?: string[]; productIds?: string[] },
): Promise<void> {
  if (!cart) return;
  const all = await tx.extensions.listAll<StoreCartItemData>(cartItemModel, {
    where: { userId: { eq: userId } },
  });
  if (cart.cartItemIds?.length) {
    const wanted = new Set(cart.cartItemIds);
    for (const item of all)
      if (wanted.has(item.name)) await tx.extensions.delete(cartItemModel, item.name);
  } else if (cart.productIds?.length) {
    const wanted = new Set(cart.productIds);
    for (const item of all)
      if (wanted.has(item.spec.productId)) await tx.extensions.delete(cartItemModel, item.name);
  }
}

async function placeOrder(
  ctx: PluginContext,
  userId: string,
  paymentMode: 'wallet' | 'external',
  lines: OrderLine[],
  options: { channelCode?: string; methodId?: string; providerId?: string; paymentMethod?: string },
  req: HttpRequest,
  cart?: { cartItemIds?: string[]; productIds?: string[] },
): Promise<unknown> {
  const discount = await effectiveDiscount(userId);

  if (paymentMode === 'wallet') {
    const order = await runTransaction(async (tx) => {
      const { orderId, settlementCurrency, settlementTotal } = await reserve(
        tx,
        userId,
        lines,
        options,
        discount,
      );
      // The wallet only holds CNY this phase (plan §4.4). Refuse a foreign
      // settlement currency explicitly instead of surfacing a confusing
      // "insufficient balance" for an account that cannot exist.
      if (settlementCurrency !== WALLET_CURRENCY) {
        throw new StoreError(
          409,
          `钱包仅支持 ${WALLET_CURRENCY} 结算，请选择其他支付方式或调整结算币种`,
          'currency.payment_method_unsupported',
        );
      }
      await tx.wallet.debit(userId, settlementTotal, settlementCurrency, {
        type: 'ORDER_PAYMENT',
        referenceType: 'ORDER',
        referenceId: orderId,
        note: `Order ${orderId}`,
      });
      await tx.extensions.updateWhere(
        orderModel,
        { name: { eq: orderId }, state: { eq: 'PENDING' } },
        { state: { set: 'PAID' } },
      );
      await removeCartInTx(tx, userId, cart);
      const paid = await tx.extensions.get<StoreOrderData>(orderModel, orderId);
      if (!paid) throw new StoreError(503, '商店插件未就绪');
      // W1: the event commits with the order state change (same transaction).
      tx.publish('order.paid', { orderId: paid.name, userId });
      return toOrder(paid);
    });
    await notifyUser({
      userId: order.userId,
      type: 'order.paid',
      title: '订单支付成功',
      body: `订单 ${order.id} 已支付成功（${formatAmountPair(order)}），正在为你开通服务。`,
      link: `/account/orders`,
      data: {
        orderId: order.id,
        total: order.settlementTotal,
        currency: order.settlementCurrency,
        orderTotal: order.total,
        orderCurrency: order.currency,
      },
      status: 'success',
      dedupeKey: `store:order:${order.id}:paid`,
    });
    // 审计：记录订单支付结果（金额/币种/商品数），不含任何支付凭据。
    await recordStoreAudit({
      action: STORE_AUDIT_ACTIONS.orderPaid,
      resource: 'store/order',
      resourceId: order.id,
      ...auditActor(req),
      meta: {
        paymentMode: 'wallet',
        total: order.total,
        currency: order.currency,
        itemCount: lines.length,
      },
    });
    return {
      order,
      nextPath: cart?.cartItemIds
        ? `/account/store/cart?orderId=${encodeURIComponent(order.id)}`
        : '/account/orders',
    };
  }

  const providerId = options.providerId;
  const paymentMethod = options.paymentMethod;
  if (!providerId || !paymentMethod) throw new StoreError(400, '请选择支付方式');
  const reserved = await runTransaction(async (tx) => {
    const { resolved, total, orderId, currency, settlementCurrency, settlementTotal, fxRate } =
      await reserve(tx, userId, lines, options, discount);
    const payment = await tx.payments.createRecord({
      purpose: 'ORDER',
      userId,
      orderId,
      amount: settlementTotal,
      currency: settlementCurrency,
      ...(options.methodId ? { methodId: options.methodId } : {}),
      ...(currency !== settlementCurrency
        ? { orderCurrency: currency, orderAmount: total, fxRate }
        : {}),
      providerId,
      paymentMethod,
      subject: '',
      returnPath: cart?.cartItemIds
        ? `/account/store/cart?orderId=${encodeURIComponent(orderId)}`
        : '/account/orders',
    });
    return { orderId, payment, subject: resolved.map((line) => line.name).join('、') };
  });
  const payment = await ctx.payments.initiate(reserved.payment.id, {
    returnPath: cart?.cartItemIds
      ? `/account/store/cart?orderId=${encodeURIComponent(reserved.orderId)}`
      : '/account/orders',
    subject: reserved.subject,
    ...(req.ip ? { clientIp: req.ip } : {}),
  });
  await removePurchasedCartItems(userId, cart).catch((error) => {
    logger().warn(`store: cart cleanup failed for order ${reserved.orderId}: ${String(error)}`);
  });
  const order = await getOrder(reserved.orderId);
  if (order) {
    await notifyUser({
      userId: order.userId,
      type: 'order.pending',
      title: '订单待支付',
      body: `订单 ${order.id} 已创建（${formatAmountPair(order)}），请在支付页面完成付款。`,
      link: `/account/orders`,
      data: {
        orderId: order.id,
        total: order.settlementTotal,
        currency: order.settlementCurrency,
        orderTotal: order.total,
        orderCurrency: order.currency,
      },
      status: 'info',
      dedupeKey: `store:order:${order.id}:pending`,
    });
    // 审计：外部支付待付款订单创建（仅金额/币种/商品数，不含凭据）。
    await recordStoreAudit({
      action: STORE_AUDIT_ACTIONS.orderPending,
      resource: 'store/order',
      resourceId: order.id,
      ...auditActor(req),
      meta: {
        paymentMode: 'external',
        total: order.total,
        currency: order.currency,
        itemCount: lines.length,
      },
    });
  }
  return { order, payment };
}

export async function createOrder(ctx: PluginContext, req: HttpRequest): Promise<unknown> {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const input = parsed.data;
  return placeOrder(
    ctx,
    userId,
    input.paymentMode,
    [
      {
        productId: input.productId,
        quantity: input.quantity,
        ...(input.config ? { config: input.config } : {}),
      },
    ],
    orderOptions(input.channelCode, input.methodId, input.providerId, input.paymentMethod),
    req,
    { productIds: [input.productId] },
  );
}

export async function checkoutCart(ctx: PluginContext, req: HttpRequest): Promise<unknown> {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const input = parsed.data;
  const items = await listCartItemsForCheckout(userId, input.cartItemIds);
  if (items.length === 0) throw new StoreError(409, '购物车为空');
  return placeOrder(
    ctx,
    userId,
    input.paymentMode,
    items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      ...(item.config ? { config: item.config } : {}),
    })),
    orderOptions(input.channelCode, input.methodId, input.providerId, input.paymentMethod),
    req,
    { cartItemIds: items.map((item) => item.id) },
  );
}

/** 按勾选 id 取购物车项（仅属于该用户）。 */
async function listCartItemsForCheckout(
  userId: string,
  ids: string[],
): Promise<Array<{ id: string; productId: string; quantity: number; config: unknown }>> {
  const all = await context().extensions.listAll<StoreCartItemData>(cartItemModel, {
    where: { userId: { eq: userId } },
  });
  const wanted = new Set(ids);
  return all
    .filter((item) => wanted.has(item.name))
    .map((item) => ({
      id: item.name,
      productId: item.spec.productId,
      quantity: item.spec.quantity,
      config: item.spec.config,
    }));
}

export async function listMyOrders(req: HttpRequest): Promise<unknown> {
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const { page, pageSize } = parsePagination(req.query);
  const { items: orders, total } = await listOrdersForUserPage(userId, page, pageSize);
  const payments = await context().payments.listByOrderIds(orders.map((order) => order.id));
  const byOrder = new Map(payments.map((payment) => [payment.orderId, payment]));
  return {
    orders: orders.map((order) => ({ ...order, payment: byOrder.get(order.id) ?? null })),
    total,
    page,
    pageSize,
  };
}

/** Exact, owner-scoped order status for the cart payment return flow. */
export async function getMyOrder(req: HttpRequest): Promise<unknown> {
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const parsed = idSchema.safeParse(req.params);
  if (!parsed.success) throw new StoreError(400, '订单 ID 无效');
  const order = await findOrderForUser(parsed.data.id, userId);
  if (!order) throw new StoreError(404, '订单不存在');
  const payments = await context().payments.listByOrderIds([order.id]);
  const payment = payments.find((item) => item.orderId === order.id);
  /*
   * A PENDING order must always tell the buyer what to do next.
   *
   * Online gateways give a `paymentUrl` to continue at. Manual methods (bank
   * transfer / QR code) have no URL at all — the instructions *are* the payment
   * step, so an order page showing only “待支付” leaves the customer with no
   * account number, no QR, and no idea whether to wait. Include the recovered
   * instructions so the UI can render them instead of an empty state.
   */
  const pending = order.status === 'PENDING';
  const instructions =
    pending && payment && !payment.paymentUrl
      ? await context().payments.manualInstructions(payment.id)
      : null;
  const items = publicOrderLines(order.items, order.currency);
  return {
    order: {
      id: order.id,
      status: order.status,
      ...(items.length ? { items: { items } } : {}),
      total: order.total,
      currency: order.currency,
      settlementTotal: order.settlementTotal,
      settlementCurrency: order.settlementCurrency,
      ...(order.channelCode ? { channelCode: order.channelCode } : {}),
      ...(order.createdAt ? { createdAt: order.createdAt } : {}),
      ...(order.updatedAt ? { updatedAt: order.updatedAt } : {}),
      paymentUrl: pending ? (payment?.paymentUrl ?? null) : null,
      ...(payment?.id
        ? {
            payment: {
              id: payment.id,
              providerId: payment.providerId,
              paymentMethod: payment.paymentMethod,
              paymentUrl: payment.paymentUrl,
              status: payment.status,
              createdAt: payment.createdAt,
            },
          }
        : {}),
      ...(instructions ? { paymentInstructions: instructions } : {}),
    },
  };
}

/**
 * Project the order's frozen line snapshot onto buyer-safe fields.
 *
 * Checkout selections can carry provider secrets or credentials introduced by
 * a product extension. The order page only needs name/price/quantity, so never
 * forward the raw `config` object to the browser.
 */
function publicOrderLines(
  items: unknown,
  fallbackCurrency: string,
): Array<{
  productId: string;
  name: string;
  price: number;
  currency: string;
  quantity: number;
  description?: string;
}> {
  const source =
    items && typeof items === 'object' && Array.isArray((items as { items?: unknown }).items)
      ? (items as { items: unknown[] }).items
      : [];
  return source.flatMap((line) => {
    if (!line || typeof line !== 'object') return [];
    const value = line as Record<string, unknown>;
    if (
      typeof value.name !== 'string' ||
      typeof value.price !== 'number' ||
      typeof value.quantity !== 'number'
    ) {
      return [];
    }
    return [
      {
        productId: typeof value.productId === 'string' ? value.productId : '',
        name: value.name,
        price: value.price,
        currency: typeof value.currency === 'string' ? value.currency : fallbackCurrency,
        quantity: value.quantity,
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
      },
    ];
  });
}

export async function cancelOrder(ctx: PluginContext, req: HttpRequest): Promise<unknown> {
  const parsed = idSchema.safeParse(req.params);
  if (!parsed.success) throw new StoreError(400, '订单 ID 无效');
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const order = await findOrderForUser(parsed.data.id, userId);
  if (!order || order.status !== 'PENDING') throw new StoreError(409, '订单无法取消');

  // Phase 1: claim the order so a concurrent settle cannot mark it PAID while
  // the external close is in flight. The payment itself is claimed by the kernel.
  const claimed = await changeOrderState(order.id, 'PENDING', 'CANCELLING');
  if (!claimed) throw new StoreError(409, '订单无法取消');

  const result = await ctx.payments.cancelExternalPayment(order.id);
  if (!result.cancelled) {
    await changeOrderState(order.id, 'CANCELLING', 'PENDING');
    throw new StoreError(409, '支付仍在处理中，无法取消');
  }

  const cancelled = await runTransaction(async (tx) => {
    const { updated } = await tx.extensions.updateWhere(
      orderModel,
      { name: { eq: order.id }, state: { eq: 'CANCELLING' } },
      { state: { set: 'CANCELLED' } },
    );
    if (updated === 0) throw new StoreError(409, '订单状态已变更');
    const record = await tx.extensions.get<StoreOrderData>(orderModel, order.id);
    if (record) {
      for (const item of stockItems({ items: record.spec.items })) {
        // 续费行与变配行都不占用库存（变配订单在 changes.ts 直接建单，从未 reserve），
        // 回补它们会给目标商品凭空增加库存。
        if (item.renewalServiceId || item.changeServiceId) continue;
        await tx.extensions.updateWhere(
          productModel,
          { name: { eq: item.productId } },
          { stock: { inc: item.quantity } },
        );
      }
    }
    return true;
  });
  // 审计：订单取消（含库存回补语义）；仅记 id 与结果，不含支付凭据。
  await recordStoreAudit({
    action: STORE_AUDIT_ACTIONS.orderCancelled,
    resource: 'store/order',
    resourceId: order.id,
    ...auditActor(req),
    meta: { cancelled },
  });
  // 取消成功才回执；幂等键含订单，重复点击不会累积。
  await notifyUser({
    userId,
    type: 'order.cancelled',
    title: '订单已取消',
    body: `订单 ${order.id} 已取消，占用的库存已释放。`,
    link: '/account/orders',
    data: { orderId: order.id },
    status: 'info',
    dedupeKey: `store:order:${order.id}:cancelled`,
  });
  return { cancelled };
}

export async function listAdminOrders(req: HttpRequest): Promise<unknown> {
  const { page, pageSize } = parsePagination(req.query);
  const { items: orders, total } = await listAllOrdersPage(page, pageSize);
  return { orders, total, page, pageSize };
}

/**
 * Commerce-owned settlement handler dispatched by the kernel. `settle` marks
 * the order PAID (the kernel claims the payment); `release` restores stock and
 * cancels the order when the kernel's expiry sweep or a definitive provider
 * failure cancels the payment.
 */
export const settlementHandler: PaymentSettlementHandler = {
  async settle(payment: ResolvedPaymentSettlement) {
    if (payment.purpose !== 'ORDER' || !payment.orderId)
      return { applied: false, purpose: 'ORDER' };
    try {
      // Callback consistency (plan §4.4 / §6): a settlement whose currency or
      // amount differs from the order's frozen snapshot must never mark it
      // paid. The kernel already reconciles against the payment record; this is
      // the second, order-side check that catches a stale/edited order.
      const snapshot = await getOrder(payment.orderId);
      if (!snapshot) throw new StoreError(404, '订单不存在');
      if (
        snapshot.settlementCurrency !== payment.currency ||
        snapshot.settlementTotal !== payment.amount
      ) {
        throw new StoreError(409, '结算币种或金额与订单不一致', 'currency.settlement_unsupported');
      }
      // W1: the state change and the `order.paid` event commit together.
      const applied = await runTransaction(async (tx) => {
        const { updated } = await tx.extensions.updateWhere(
          orderModel,
          { name: { eq: payment.orderId as string }, state: { eq: 'PENDING' } },
          { state: { set: 'PAID' } },
        );
        if (updated === 0) return false;
        tx.publish('order.paid', {
          orderId: payment.orderId as string,
          userId: payment.userId,
        });
        return true;
      });
      if (!applied) {
        // The order was not PENDING. If it is already PAID the settlement has
        // effectively happened (e.g. a replayed callback after a crash between
        // the kernel claim and this handler) — report success so the retry
        // converges. Any other state (CANCELLED/REFUNDED/…) is a genuine
        // conflict and must surface.
        const current = await getOrder(payment.orderId);
        if (current?.status === 'PAID') return { applied: true, purpose: 'ORDER' };
        throw new StoreError(409, '订单不可支付');
      }
      await notifyUser({
        userId: payment.userId,
        type: 'order.paid',
        title: '订单支付成功',
        body: `订单 ${payment.orderId} 已支付成功，正在为你开通服务。`,
        link: `/account/orders`,
        data: {
          orderId: payment.orderId,
          total: payment.amount,
          currency: payment.currency,
        },
        status: 'success',
        dedupeKey: `store:order:${payment.orderId}:paid`,
      });
      // 审计：外部支付回调结算成功（不含支付凭据 / provider 内部字段）。
      await recordStoreAudit({
        action: STORE_AUDIT_ACTIONS.orderPaid,
        resource: 'store/order',
        resourceId: payment.orderId,
        actorId: payment.userId,
        meta: { paymentMode: 'external', purpose: payment.purpose },
      });
      return { applied, purpose: 'ORDER' };
    } catch (error) {
      // A deactivated plugin (context reset) must not 503 the payment kernel:
      // report "not applied" so the kernel can reconcile the payment (REVIEW).
      if (error instanceof StoreError && error.status === 503) {
        return { applied: false, purpose: 'ORDER' };
      }
      logger().error(
        `store: settlement failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw error;
    }
  },
  async release(payment: ResolvedPaymentSettlement) {
    if (payment.purpose !== 'ORDER' || !payment.orderId) return { applied: false };
    try {
      const applied = await runTransaction(async (tx) => {
        const record = await tx.extensions.get<StoreOrderData>(
          orderModel,
          payment.orderId as string,
        );
        if (!record || record.spec.state !== 'PENDING') return false;
        const { updated } = await tx.extensions.updateWhere(
          orderModel,
          { name: { eq: payment.orderId as string }, state: { eq: 'PENDING' } },
          { state: { set: 'CANCELLED' } },
        );
        if (updated === 0) return false;
        for (const item of stockItems({ items: record.spec.items })) {
          // 续费行与变配行都不占用库存，见 cancelOrder。
          if (item.renewalServiceId || item.changeServiceId) continue;
          await tx.extensions.updateWhere(
            productModel,
            { name: { eq: item.productId } },
            { stock: { inc: item.quantity } },
          );
        }
        return true;
      });
      return { applied };
    } catch (error) {
      if (error instanceof StoreError && error.status === 503) {
        return { applied: false };
      }
      throw error;
    }
  },
};
