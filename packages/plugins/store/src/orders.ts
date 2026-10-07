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
import { resolveCheckoutPrice } from './pricing';

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

/** 用户所在权限组的最大代理折扣（%），无折扣返回 0。 */
async function effectiveDiscount(userId: string): Promise<number> {
  const groups = await context().auth.listUserGroups(userId);
  let max = 0;
  for (const group of groups) {
    if (group.discount != null && group.discount > max) max = group.discount;
  }
  return max;
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
    // Enforce a single currency per order: summing amounts of different
    // currencies into one total would be financially incorrect.
    if (orderCurrency !== null && product.currency !== orderCurrency) {
      throw new StoreError(409, '订单商品币种不一致，请分开下单');
    }
    orderCurrency = product.currency;
    const config = parseCheckoutSelection(line.config);
    // 折扣计价：商品自身折扣与用户权限组折扣取更优（% off）。
    const productDiscount = product.discount ?? 0;
    const effective = Math.max(discount, productDiscount);
    let baseUnit = product.price;
    let configSummary: string | undefined;
    if (config) {
      const { unit, result } = await resolveCheckoutPrice(
        { id: line.productId, ...product },
        line.quantity,
        config,
      );
      baseUnit = unit;
      configSummary = result?.summary;
    }
    const discountedUnit =
      effective > 0 ? Math.round((baseUnit * (100 - effective)) / 100) : baseUnit;
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
  const currency = orderCurrency ?? 'CNY';
  const quote = await context().fx.quote(currency, 'CNY', total);
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
      return toOrder(paid);
    });
    bus().publish('order.paid', { orderId: order.id });
    return { order, nextPath: '/account/orders' };
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
      returnPath: '/account/orders',
    });
    return { orderId, payment, subject: resolved.map((line) => line.name).join('、') };
  });
  const payment = await ctx.payments.initiate(reserved.payment.id, {
    returnPath: '/account/orders',
    subject: reserved.subject,
    ...(req.ip ? { clientIp: req.ip } : {}),
  });
  await removePurchasedCartItems(userId, cart).catch((error) => {
    logger().warn(`store: cart cleanup failed for order ${reserved.orderId}: ${String(error)}`);
  });
  const order = await getOrder(reserved.orderId);
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
        await tx.extensions.updateWhere(
          productModel,
          { name: { eq: item.productId } },
          { stock: { inc: item.quantity } },
        );
      }
    }
    return true;
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
      const applied = await changeOrderState(payment.orderId, 'PENDING', 'PAID');
      if (!applied) throw new StoreError(409, '订单不可支付');
      bus().publish('order.paid', { orderId: payment.orderId });
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
