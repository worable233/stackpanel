import type {
  CheckoutPriceContext,
  CheckoutSelection,
  FulfillmentProvider,
  HttpRequest,
  PluginContext,
  ProviderServiceContext,
} from '@stackpanel/sdk';
import { WALLET_CURRENCY } from '@stackpanel/sdk';
import { context, logger, runTransaction } from './context';
import { StoreError, stockItems } from './errors';
import {
  applyServiceChange,
  providerForProduct,
  providerForService,
  providerServiceContext,
} from './fulfillment';
import { resolveCheckoutPrice } from './pricing';
import { quoteSettlement } from './currency';
import type { ProductRecord, ServiceInstanceRecord } from './repository';
import {
  getProduct,
  getService,
  replaceServiceInstance,
  toOrder,
  toServiceInstanceData,
} from './repository';
import {
  orderModel,
  serviceInstanceModel,
  type StoreOrderData,
  type StoreServiceInstanceData,
} from './data';
import {
  changeQuoteSchema,
  changeServiceSchema,
  cycleMonths,
  monthsForCycle,
  parseCheckoutSelection,
} from './utils';

/**
 * 服务变配（升配/降配/换商品）与转移。
 *
 * 升配/降配本质是「针对已购服务再下一单」：金额为**差价**（按剩余周期比例折算），
 * 不占用库存、不清购物车、不产生交付任务。支付成功（`order.paid`）后调用提供方的
 * `changePackage`/`changeProduct`，把新配置写回服务 runtime，并以 `changeApplied`
 * 标记幂等。
 *
 * 差价口径：优先由提供方 `calculateChangePrice` 权威试算（上游走 get_total）；
 * 缺省用本地 checkoutConfig「新配置价 − 旧配置价」按剩余周期天数比例估算。
 */

const CHANGEABLE_STATES = new Set(['ACTIVE', 'SUSPENDED']);

/** 从服务 runtime 读取已购结账配置选择。 */
export function readServiceSelection(service: { runtime: unknown }): CheckoutSelection | undefined {
  const runtime = (service.runtime ?? {}) as Record<string, unknown>;
  const config = runtime['config'];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  return config as CheckoutSelection;
}

/** 剩余周期比例（0–1）：到期时间距现在不足一个周期时按比例折算差价。 */
function remainingFraction(expiresAt: Date | null, cycleMonths: number): number {
  if (!expiresAt) return 1;
  const remainingMs = expiresAt.getTime() - Date.now();
  if (remainingMs <= 0) return 0;
  const periodMs = Math.max(cycleMonths, 1) * 30 * 24 * 60 * 60 * 1000;
  return Math.min(remainingMs / periodMs, 1);
}

/** 解析变配目标商品：换商品时取目标商品；否则沿用当前商品。 */
async function resolveTargetProduct(
  service: { productId: string },
  input: { targetProductId?: string | undefined },
): Promise<ProductRecord> {
  const product = await getProduct(input.targetProductId ?? service.productId);
  if (!product) throw new StoreError(404, '商品不存在');
  return product;
}

export interface ChangeQuote {
  /** 旧配置单价（minor）。 */
  from: number;
  /** 新配置单价（minor）。 */
  to: number;
  /** 需补差价（minor，负数按 0 处理）。 */
  diff: number;
  currency: string;
  summary?: string;
  breakdown?: unknown;
}

/** 计算变更差价。正数=需补差价；差额退还按 0 处理（前端提示）。 */
async function computeChangeDiff(
  service: ServiceInstanceRecord,
  product: ProductRecord,
  configRaw: string | undefined,
): Promise<ChangeQuote> {
  const newSelection = parseCheckoutSelection(configRaw);
  const from = readServiceSelection(service);
  const isProductChange = product.id !== service.productId;
  const provider: FulfillmentProvider | null = providerForProduct({
    providerId: product.providerId,
    fulfillmentType: product.fulfillmentType,
  });
  // 权威试算仅适用于「同一商品内升配/降配」：上游（如 zjmf）的变配试算按配置项
  // 差价计价，跨商品时配置 id 无意义，故换商品一律回退本地差额估算。
  if (!isProductChange && newSelection && provider?.calculateChangePrice) {
    const ctx: CheckoutPriceContext & {
      from?: CheckoutSelection;
      service?: ProviderServiceContext['service'];
    } = {
      product: {
        id: product.id,
        price: product.price,
        currency: product.currency,
        metadata: product.metadata,
        providerProductId: product.providerProductId,
      },
      quantity: 1,
      config: newSelection,
      service: providerServiceContext(service).service,
      ...(from ? { from } : {}),
    };
    try {
      const result = await provider.calculateChangePrice(ctx);
      const diff = Math.round(result.price);
      return {
        from: 0,
        to: diff,
        diff,
        currency: product.currency,
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.breakdown ? { breakdown: result.breakdown } : {}),
      };
    } catch (error) {
      // 上游不支持/试算失败时降级为本地差额估算，不阻断下单。
      logger().warn(
        `store: change price quote failed for service ${service.id}: ${messageOf(error)}`,
      );
    }
  }
  if (!newSelection && !isProductChange) throw new StoreError(400, '缺少目标配置');
  // 旧价须按**服务当前商品**解析（换商品时目标商品的配置并不代表旧配置的价格）。
  const currentProduct = isProductChange ? await getProduct(service.productId) : product;
  const oldUnit =
    from && currentProduct
      ? (await resolveCheckoutPrice(currentProduct, 1, from)).unit
      : (currentProduct?.price ?? product.price);
  const newUnit = (await resolveCheckoutPrice(product, 1, newSelection)).unit;
  // 剩余比例按服务**实际计费周期**折算，而不是硬编码 1 个月；周期取自服务当前商品
  // 的 metadata 与开通时选择的 cycle。
  const cycleMonthsValue =
    cycleMonths(currentProduct?.metadata ?? product.metadata, from?.cycle) ??
    monthsForCycle(from?.cycle ?? '') ??
    1;
  const fraction = remainingFraction(service.expiresAt, cycleMonthsValue);
  const diff = Math.max(0, Math.round((newUnit - oldUnit) * fraction));
  return {
    from: oldUnit,
    to: newUnit,
    diff,
    currency: product.currency,
    ...(newSelection?.summary ? { summary: newSelection.summary } : {}),
  };
}

/** GET/POST /services/:id/change-quote —— 升配/降配差价试算。 */
export async function quoteServiceChange(req: HttpRequest): Promise<unknown> {
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const service = await getService(id);
  if (!service || service.userId !== userId) throw new StoreError(404, '服务不存在');
  const parsed = changeQuoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  const target = await resolveTargetProduct(service, parsed.data);
  return computeChangeDiff(service, target, parsed.data.config);
}

/** POST /services/:id/change —— 下变配订单（升配/降配/换商品）。 */
export async function changeService(ctx: PluginContext, req: HttpRequest): Promise<unknown> {
  const parsed = changeServiceSchema.safeParse(req.body);
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const input = parsed.data;
  const serviceId = req.params['id'] ?? input.serviceId;
  if (!serviceId) throw new StoreError(400, '缺少服务 ID');

  const service = await getService(serviceId);
  if (!service || service.userId !== userId) throw new StoreError(404, '服务不存在');
  if (!CHANGEABLE_STATES.has(service.status)) throw new StoreError(409, '该服务当前状态不可变更');

  const product = await resolveTargetProduct(service, input);
  if (product.status !== 'ACTIVE') throw new StoreError(409, '商品不可用');
  const changeType =
    input.targetProductId && input.targetProductId !== service.productId ? 'product' : 'package';
  const quoteDiff = await computeChangeDiff(service, product, input.config);
  const unit = quoteDiff.diff;
  if (!Number.isInteger(unit) || unit < 0) throw new StoreError(400, '订单金额无效');

  const line: Record<string, unknown> = {
    productId: product.id,
    quantity: 1,
    name: product.name,
    price: unit,
    currency: product.currency,
    changeServiceId: service.id,
    changeType,
    ...(input.targetProductId ? { changeTargetProductId: input.targetProductId } : {}),
    ...(input.config ? { changeSelection: parseCheckoutSelection(input.config) } : {}),
  };

  if (unit === 0) {
    // 零差额（降配/等价换配）不产生金额，任何支付方式都无法「支付」它：
    // `wallet.debit` / 外部下单都拒绝非正数。直接落 PAID 让变更立即生效。
    const order = await runTransaction(async (tx) => {
      const created = await tx.extensions.create<StoreOrderData>(orderModel, {
        userId,
        items: { items: [line] },
        total: 0,
        currency: product.currency,
        state: 'PAID',
        channelCode: input.channelCode ?? 'MALL_PC',
        settlementCurrency: product.currency,
        settlementTotal: 0,
        fxRate: null,
      });
      tx.publish('order.paid', { orderId: created.name, userId });
      return toOrder(created);
    });
    return { order, nextPath: '/account/services' };
  }

  if (input.paymentMode === 'wallet') {
    const order = await runTransaction(async (tx) => {
      const fx = await quoteSettlement(context(), product.currency, unit);
      const created = await tx.extensions.create<StoreOrderData>(orderModel, {
        userId,
        items: { items: [line] },
        total: unit,
        currency: product.currency,
        state: 'PENDING',
        channelCode: input.channelCode ?? 'MALL_PC',
        settlementCurrency: fx.toCurrency,
        settlementTotal: fx.settlementAmount,
        fxRate: fx.rate ?? null,
      });
      const orderId = created.name;
      // The wallet only holds CNY (plan §4.4); refuse a foreign settlement
      // currency with a stable code instead of an "insufficient balance" error.
      if (fx.toCurrency !== WALLET_CURRENCY) {
        throw new StoreError(
          409,
          `钱包仅支持 ${WALLET_CURRENCY} 结算，请选择其他支付方式`,
          'currency.payment_method_unsupported',
        );
      }
      await tx.wallet.debit(userId, fx.settlementAmount, fx.toCurrency, {
        type: 'ORDER_PAYMENT',
        referenceType: 'ORDER',
        referenceId: orderId,
        note: `Change ${orderId}`,
      });
      await tx.extensions.updateWhere(
        orderModel,
        { name: { eq: orderId }, state: { eq: 'PENDING' } },
        { state: { set: 'PAID' } },
      );
      const paid = await tx.extensions.get<StoreOrderData>(orderModel, orderId);
      if (!paid) throw new StoreError(503, '商店插件未就绪');
      tx.publish('order.paid', { orderId: paid.name, userId });
      return toOrder(paid);
    });
    return { order, nextPath: '/account/services' };
  }

  if (!input.providerId || !input.paymentMethod) throw new StoreError(400, '请选择支付方式');
  const reserved = await runTransaction(async (tx) => {
    const fx = await quoteSettlement(context(), product.currency, unit);
    const created = await tx.extensions.create<StoreOrderData>(orderModel, {
      userId,
      items: { items: [line] },
      total: unit,
      currency: product.currency,
      state: 'PENDING',
      channelCode: input.channelCode ?? 'MALL_PC',
      settlementCurrency: fx.toCurrency,
      settlementTotal: fx.settlementAmount,
      fxRate: fx.rate ?? null,
    });
    const payment = await tx.payments.createRecord({
      purpose: 'ORDER',
      userId,
      orderId: created.name,
      amount: fx.settlementAmount,
      currency: fx.toCurrency,
      ...(input.methodId ? { methodId: input.methodId } : {}),
      providerId: input.providerId as string,
      paymentMethod: input.paymentMethod as string,
      subject: `变配：${product.name}`,
      returnPath: '/account/services',
    });
    return { orderId: created.name, payment };
  });
  const payment = await ctx.payments.initiate(reserved.payment.id, {
    returnPath: '/account/services',
    subject: `变配：${product.name}`,
    ...(req.ip ? { clientIp: req.ip } : {}),
  });
  const order = await toOrder(
    (await context().extensions.get<StoreOrderData>(orderModel, reserved.orderId))!,
  );
  return { order, payment };
}

/**
 * 处理 `order.paid` 中的变配行：调用提供方变更配置、写回新配置与幂等标记，并记录
 * 变更前的配置/商品供全额退款回滚。
 */
export async function applyChangeOrder(orderId: string): Promise<void> {
  const record = await context().extensions.get<StoreOrderData>(orderModel, orderId);
  if (!record) return;
  const raw = record.spec.items as { items?: Array<Record<string, unknown>> } | null;
  const rawItems = Array.isArray(raw?.items) ? raw!.items : [];
  for (const line of stockItems({ items: record.spec.items })) {
    if (!line.changeServiceId) continue;
    const rawLine = rawItems.find(
      (candidate) =>
        candidate['changeServiceId'] === line.changeServiceId &&
        candidate['productId'] === line.productId,
    );
    if (rawLine?.['changeApplied'] === true) continue;
    const service = await getService(line.changeServiceId);
    if (!service || service.userId !== record.spec.userId) continue;
    const changeType = line.changeType === 'product' ? 'product' : 'package';
    const selection =
      line.changeSelection && typeof line.changeSelection === 'object'
        ? (line.changeSelection as CheckoutSelection)
        : undefined;
    const targetProductId = line.changeTargetProductId;
    // 换商品：从目标商品读取新的履约绑定（上游商品 id / providerId / 类型）。
    const targetProduct =
      changeType === 'product' && targetProductId ? await getProduct(targetProductId) : null;
    const targetProviderProductId =
      changeType === 'product' ? (targetProduct?.providerProductId ?? null) : undefined;
    // `applyServiceChange` 返回 false 仅表示「提供方无对应钩子」（本地/即时商品，
    // 变更仅发生在平台侧）；钩子存在但抛错时它会抛出——那种情况必须保留可重试，
    // 不能标记已应用，否则平台显示新配置而上游未变。
    let applied = true;
    try {
      applied = await applyServiceChange(service, {
        type: changeType,
        ...(selection ? { config: selection } : {}),
        ...(targetProductId ? { targetProductId } : {}),
        ...(targetProviderProductId !== undefined ? { targetProviderProductId } : {}),
      });
    } catch (error) {
      logger().error(`store: change hook failed for service ${service.id}: ${messageOf(error)}`);
      continue;
    }
    if (rawLine) {
      rawLine['previousSelection'] = readServiceSelection(service) ?? null;
      rawLine['previousProductId'] = service.productId;
      rawLine['changeApplied'] = true;
    }
    const refreshed = await getService(service.id);
    if (refreshed) {
      const currentRuntime = (refreshed.runtime ?? {}) as Record<string, unknown>;
      // 服务写回与订单行幂等标记在同一事务内落库：要么都生效要么都不生效，避免
      // 「改了服务却丢了 changeApplied → 重试再改一次」或反之。
      await runTransaction(async (tx) => {
        await tx.extensions.update<StoreServiceInstanceData>(serviceInstanceModel, refreshed.id, {
          ...toServiceInstanceData(refreshed),
          ...(targetProduct
            ? {
                productId: targetProduct.id,
                productName: String(
                  rawLine?.['name'] ?? targetProduct.name ?? refreshed.productName,
                ),
                // 同步新的履约绑定，否则后续续费/停机等钩子会命中旧提供方。
                fulfillmentType: targetProduct.fulfillmentType,
                providerId: targetProduct.providerId,
              }
            : {}),
          runtime: selection ? { ...currentRuntime, config: selection } : currentRuntime,
        });
        if (rawLine) {
          await tx.extensions.update<StoreOrderData>(orderModel, orderId, {
            ...record.spec,
            items: { items: rawItems },
          });
        }
      });
    }
    logger().info(`store: applied change for service ${service.id} (${changeType}=${applied})`);
  }
}

/**
 * 撤销变配订单对服务的影响（全额退款时调用）。按订单行记录的 `previousProductId`
 * 与 `previousSelection` 把旧配置写回（尽力而为）。
 */
export async function reverseChangeOrder(orderId: string): Promise<void> {
  const record = await context().extensions.get<StoreOrderData>(orderModel, orderId);
  if (!record) return;
  for (const line of stockItems({ items: record.spec.items })) {
    if (!line.changeServiceId) continue;
    const service = await getService(line.changeServiceId);
    if (!service || service.userId !== record.spec.userId) continue;
    const previous =
      line.previousSelection && typeof line.previousSelection === 'object'
        ? (line.previousSelection as CheckoutSelection)
        : undefined;
    const restoredProductId = line.previousProductId ?? service.productId;
    const restored = await getService(service.id);
    if (!restored) continue;
    const isProductRestore = line.changeType === 'product';
    const restoreProduct = isProductRestore ? await getProduct(restoredProductId) : null;
    const restoreProviderProductId = isProductRestore
      ? (restoreProduct?.providerProductId ?? null)
      : undefined;
    await applyServiceChange(restored, {
      type: isProductRestore ? 'product' : 'package',
      ...(previous ? { config: previous } : {}),
      ...(restoredProductId ? { targetProductId: restoredProductId } : {}),
      ...(restoreProviderProductId !== undefined
        ? { targetProviderProductId: restoreProviderProductId }
        : {}),
    }).catch(() => false);
    const currentRuntime = (restored.runtime ?? {}) as Record<string, unknown>;
    await replaceServiceInstance(restored.id, {
      ...toServiceInstanceData(restored),
      productId: restoredProductId,
      ...(restoreProduct
        ? {
            fulfillmentType: restoreProduct.fulfillmentType,
            providerId: restoreProduct.providerId,
          }
        : {}),
      runtime: previous ? { ...currentRuntime, config: previous } : currentRuntime,
    });
    logger().info(`store: reversed change for service ${restored.id}`);
  }
}

/** POST /store/admin/services/:id/transfer —— 产品转移（管理端）。 */
export async function transferService(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const targetUserId = (req.body as { targetUserId?: unknown } | null)?.targetUserId;
  if (typeof targetUserId !== 'string' || !targetUserId) {
    throw new StoreError(400, '缺少目标用户');
  }
  const service = await getService(id);
  if (!service) throw new StoreError(404, '服务不存在');
  if (service.userId === targetUserId) throw new StoreError(409, '服务已属于该用户');
  // 目标用户必须真实存在，否则会把履约物转移到悬空 user id（后续鉴权/续费全失效）。
  const target = await context().auth.getUser(targetUserId);
  if (!target) throw new StoreError(404, '目标用户不存在');
  const provider = providerForService(service);
  if (provider?.changeOwner) {
    await provider.changeOwner(
      {
        service: {
          id: service.id,
          providerId: service.providerId,
          providerServiceId: service.providerServiceId,
          runtime: service.runtime,
          credentialsRef: service.credentialsRef,
          userId: service.userId,
          orderId: service.orderId,
          productId: service.productId,
          productName: service.productName,
          status: service.status,
        },
        secrets: context().secrets,
      },
      targetUserId,
    );
  }
  await replaceServiceInstance(service.id, {
    ...toServiceInstanceData(service),
    userId: targetUserId,
  });
  // 审计：谁把哪个履约物转给了谁（此前无任何留痕）。
  await context()
    .auth.audit({
      action: 'store.service.transfer',
      resource: 'store/service',
      resourceId: service.id,
      ...(req.user?.id ? { actorId: req.user.id } : {}),
      meta: { fromUserId: service.userId, toUserId: targetUserId },
      ...(req.ip ? { ip: req.ip } : {}),
    })
    .catch((error) => {
      logger().warn(`store: transfer audit failed for ${service.id}: ${messageOf(error)}`);
    });
  logger().info(`store: transferred service ${service.id} to ${targetUserId}`);
  return { transferred: true, targetUserId };
}

/** 判断订单是否包含变配行（履约调度器据此跳过 provision）。 */
export function hasChangeLine(order: { items: unknown }): boolean {
  return stockItems(order).some((line) => Boolean(line.changeServiceId));
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}

// 供 repository 类型引用（避免未使用告警）。
export type { ServiceInstanceRecord };
