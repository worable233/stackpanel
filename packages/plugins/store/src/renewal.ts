import type { HttpRequest, PluginContext } from '@stackpanel/sdk';
import { bus, context, logger, runTransaction } from './context';
import { StoreError, stockItems } from './errors';
import { applyServiceLifecycleAction } from './fulfillment';
import {
  getProduct,
  getService,
  replaceServiceInstance,
  toOrder,
  toServiceInstanceData,
} from './repository';
import { orderModel, type StoreOrderData } from './data';
import { monthsForCycle, readCycles, renewOrderSchema } from './utils';

/**
 * 续费（renew）。
 *
 * 续费本质是「针对已购服务再下一单」：金额按商品续费价（`renewPrice`，缺省等于现价）
 * 计算，但不占用库存、不清购物车、不产生交付任务。支付成功（`order.paid`）后把服务
 * 的 `expiresAt` 顺延（暂停中的服务一并恢复），并重置到期处理阶段。
 *
 * 订单行通过 `renewalServiceId` + `renewMonths` 标记；履约调度器据此跳过续费行的
 * provision（见 fulfillment.ts），改由 {@link applyRenewalOrder} 处理。
 */

/** 可续费的服务状态：进行中或已暂停（暂停后补费可恢复）。 */
const RENEWABLE_STATES = new Set(['ACTIVE', 'SUSPENDED']);

/** 默认续费时长（月）。 */
const DEFAULT_RENEW_MONTHS = 1;

// 周期工具集中定义在 utils（开通初始到期与续费共用同一套时长口径）。
export { monthsForCycle };

/** 从商品 metadata 的 checkoutConfig 取指定周期的续费价（缺省回退商品价）。 */
function cycleRenewPrice(product: { price: number; metadata: unknown }, cycleId?: string): number {
  const config = readCycles(product.metadata);
  if (!config) return product.price;
  const cycle = cycleId ? config.find((candidate) => candidate.id === cycleId) : config[0];
  if (!cycle) return product.price;
  return cycle.renewPrice ?? cycle.price ?? product.price;
}

/** 从 metadata/请求推断续费月数：优先显式 months，其次周期映射。 */
function resolveMonths(
  product: { metadata: unknown },
  cycleId: string | undefined,
  explicit: number | undefined,
): number {
  if (explicit && Number.isInteger(explicit) && explicit > 0) return explicit;
  const cycles = readCycles(product.metadata);
  const cycle = cycles?.find((candidate) => candidate.id === cycleId);
  if (cycle?.months && Number.isInteger(cycle.months) && cycle.months > 0) return cycle.months;
  return monthsForCycle(cycleId);
}

export async function renewService(ctx: PluginContext, req: HttpRequest): Promise<unknown> {
  const parsed = renewOrderSchema.safeParse(req.body);
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  const userId = req.user?.id;
  if (!userId) throw new StoreError(401, '未登录');
  const input = parsed.data;
  const serviceId = req.params['id'] ?? input.serviceId;
  if (!serviceId) throw new StoreError(400, '缺少服务 ID');

  const service = await getService(serviceId);
  if (!service || service.userId !== userId) throw new StoreError(404, '服务不存在');
  if (!RENEWABLE_STATES.has(service.status)) throw new StoreError(409, '该服务当前状态不可续费');

  const product = await getProduct(service.productId);
  if (!product) throw new StoreError(404, '商品不存在');

  const months = resolveMonths(product, input.cycle, input.months);
  const unit = cycleRenewPrice(product, input.cycle);
  if (!Number.isInteger(unit) || unit < 0) throw new StoreError(400, '订单金额无效');

  const line = {
    productId: product.id,
    quantity: 1,
    name: product.name,
    price: unit,
    currency: product.currency,
    renewalServiceId: service.id,
    renewMonths: months,
    ...(input.cycle ? { cycle: input.cycle } : {}),
  };

  if (input.paymentMode === 'wallet') {
    const order = await runTransaction(async (tx) => {
      const quote = await context().fx.quote(product.currency, 'CNY', unit);
      const created = await tx.extensions.create<StoreOrderData>(orderModel, {
        userId,
        items: { items: [line] },
        total: unit,
        currency: product.currency,
        state: 'PENDING',
        channelCode: input.channelCode ?? 'MALL_PC',
        settlementCurrency: quote.toCurrency,
        settlementTotal: quote.settlementAmount,
        fxRate: quote.rate ?? null,
      });
      const orderId = created.name;
      await tx.wallet.debit(userId, quote.settlementAmount, quote.toCurrency, {
        type: 'ORDER_PAYMENT',
        referenceType: 'ORDER',
        referenceId: orderId,
        note: `Renewal ${orderId}`,
      });
      await tx.extensions.updateWhere(
        orderModel,
        { name: { eq: orderId }, state: { eq: 'PENDING' } },
        { state: { set: 'PAID' } },
      );
      const paid = await tx.extensions.get<StoreOrderData>(orderModel, orderId);
      if (!paid) throw new StoreError(503, '商店插件未就绪');
      return toOrder(paid);
    });
    bus().publish('order.paid', { orderId: order.id });
    return { order, nextPath: '/account/services' };
  }

  // 外部支付：创建订单 + 支付记录，由网关结算回调发布 order.paid。
  if (!input.providerId || !input.paymentMethod) throw new StoreError(400, '请选择支付方式');
  const reserved = await runTransaction(async (tx) => {
    const quote = await context().fx.quote(product.currency, 'CNY', unit);
    const created = await tx.extensions.create<StoreOrderData>(orderModel, {
      userId,
      items: { items: [line] },
      total: unit,
      currency: product.currency,
      state: 'PENDING',
      channelCode: input.channelCode ?? 'MALL_PC',
      settlementCurrency: quote.toCurrency,
      settlementTotal: quote.settlementAmount,
      fxRate: quote.rate ?? null,
    });
    const payment = await tx.payments.createRecord({
      purpose: 'ORDER',
      userId,
      orderId: created.name,
      amount: quote.settlementAmount,
      currency: quote.toCurrency,
      ...(input.methodId ? { methodId: input.methodId } : {}),
      providerId: input.providerId as string,
      paymentMethod: input.paymentMethod as string,
      subject: `续费：${product.name}`,
      returnPath: '/account/services',
    });
    return { orderId: created.name, payment };
  });
  const payment = await ctx.payments.initiate(reserved.payment.id, {
    returnPath: '/account/services',
    subject: `续费：${product.name}`,
    ...(req.ip ? { clientIp: req.ip } : {}),
  });
  const order = await toOrder(
    (await context().extensions.get<StoreOrderData>(orderModel, reserved.orderId))!,
  );
  return { order, payment };
}

/** 把若干月加到到期时间上：基准取「较晚者(当前到期, 现在)」，避免过期后顺延丢时长。 */
export function extendExpiry(currentExpiresAt: Date | null, now: Date, months: number): Date {
  const base =
    currentExpiresAt && currentExpiresAt.getTime() > now.getTime() ? currentExpiresAt : now;
  const next = new Date(base.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
}

/**
 * 处理 `order.paid` 中的续费行：顺延对应服务的到期时间、重置到期阶段，并恢复
 * 被暂停的服务（补费即恢复，对齐魔方「续费后自动恢复」的承诺）。
 *
 * 幂等保护：处理过的订单行会被标记 `renewalApplied`，重复投递（at-least-once）不会
 * 二次顺延，也不会覆盖回滚点。续费前到期/状态写入订单行，供全额退款精确回滚。
 */
export async function applyRenewalOrder(orderId: string): Promise<void> {
  const record = await context().extensions.get<StoreOrderData>(orderModel, orderId);
  if (!record) return;
  const now = new Date();
  const raw = record.spec.items as { items?: Array<Record<string, unknown>> } | null;
  const rawItems = Array.isArray(raw?.items) ? raw!.items : [];
  let mutated = false;
  for (const line of stockItems({ items: record.spec.items })) {
    if (!line.renewalServiceId) continue;
    // 幂等：同一订单行只处理一次（重复投递不会二次顺延或覆盖回滚点）。
    const rawLine = rawItems.find(
      (candidate) =>
        candidate['renewalServiceId'] === line.renewalServiceId &&
        candidate['productId'] === line.productId,
    );
    if (rawLine?.['renewalApplied'] === true) continue;
    const service = await getService(line.renewalServiceId);
    if (!service || service.userId !== record.spec.userId) continue;
    const months =
      line.renewMonths && line.renewMonths > 0 ? line.renewMonths : DEFAULT_RENEW_MONTHS;
    const nextExpiry = extendExpiry(service.expiresAt, now, months);
    // 在原始订单行上记录续费前的到期/状态，供全额退款精确回滚（不重建行，避免丢字段）。
    if (rawLine) {
      rawLine['previousExpiresAt'] = service.expiresAt ? service.expiresAt.toISOString() : null;
      rawLine['previousState'] = service.status;
      rawLine['renewalApplied'] = true;
      mutated = true;
    }
    // 已暂停（到期暂停）的服务：补费后调上游 resume 并恢复为 ACTIVE。
    const wasSuspended = service.status === 'SUSPENDED';
    if (wasSuspended) {
      await applyServiceLifecycleAction(service, 'resume').catch((error) => {
        logger().warn(`store: renewal resume hook failed for ${service.id}: ${messageOf(error)}`);
      });
    }
    await replaceServiceInstance(service.id, {
      ...toServiceInstanceData(service),
      ...(wasSuspended ? { state: 'ACTIVE' } : {}),
      expiresAt: nextExpiry.toISOString(),
      expiresAtMs: nextExpiry.getTime(),
      expiryStage: null,
    });
    logger().info(`store: renewed service ${service.id} to ${nextExpiry.toISOString()}`);
  }
  if (mutated) {
    await context()
      .extensions.update<StoreOrderData>(orderModel, orderId, {
        ...record.spec,
        items: { items: rawItems },
      })
      .catch(() => undefined);
  }
}

/**
 * 撤销续费行对服务的到期时间顺延（全额退款时调用）。按订单行记录的
 * `previousExpiresAt` 精确回滚；恢复服务被续费顺延后的到期阶段。
 */
export async function reverseRenewalOrder(orderId: string): Promise<void> {
  const record = await context().extensions.get<StoreOrderData>(orderModel, orderId);
  if (!record) return;
  for (const line of stockItems({ items: record.spec.items })) {
    if (!line.renewalServiceId) continue;
    const service = await getService(line.renewalServiceId);
    if (!service || service.userId !== record.spec.userId) continue;
    if (line.previousExpiresAt === undefined) continue; // 未记录回滚点（旧数据）
    const restored = line.previousExpiresAt ? new Date(line.previousExpiresAt) : null;
    await replaceServiceInstance(service.id, {
      ...toServiceInstanceData(service),
      ...(line.previousState ? { state: line.previousState } : {}),
      expiresAt: restored ? restored.toISOString() : null,
      expiresAtMs: restored ? restored.getTime() : null,
      // 回滚到期阶段，使服务按恢复后的到期时间重新走一遍提醒/暂停。
      expiryStage: null,
    });
    logger().info(`store: reversed renewal for service ${service.id}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}

/** 判断订单是否包含续费行（履约调度器据此决定是否跳过 provision）。 */
export function hasRenewalLine(order: { items: unknown }): boolean {
  return stockItems(order).some((line) => Boolean(line.renewalServiceId));
}
