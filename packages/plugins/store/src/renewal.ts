import type { HttpRequest, PluginContext } from '@stackpanel/sdk';
import { WALLET_CURRENCY } from '@stackpanel/sdk';
import { context, logger, runTransaction } from './context';
import { StoreError, stockItems } from './errors';
import { applyServiceLifecycleAction } from './fulfillment';
import {
  getProduct,
  getService,
  replaceServiceInstance,
  toOrder,
  toService,
  toServiceInstanceData,
} from './repository';
import {
  orderModel,
  serviceInstanceModel,
  type StoreOrderData,
  type StoreServiceInstanceData,
} from './data';
import { monthsForCycle, readCycles, renewOrderSchema } from './utils';
import { applyDiscount, betterDiscount, effectiveGroupDiscount } from './discount';
import { notifyUser } from './notifications';
import { quoteSettlement } from './currency';

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
  // 续费与首购走同一套折扣规则（discount.ts）：否则用户首期享受折扣、续费却
  // 恢复原价，且商品页展示的 `renewPrice` 已扣折扣 —— 展示与实际收费不一致。
  const groupDiscount = await effectiveGroupDiscount(userId);
  const discount = betterDiscount(product.discount, groupDiscount);
  const unit = applyDiscount(cycleRenewPrice(product, input.cycle), discount);
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
      const quote = await quoteSettlement(context(), product.currency, unit);
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
      // The wallet only holds CNY (plan §4.4): a foreign settlement currency
      // cannot be debited, so fail with a stable code instead of a confusing
      // "insufficient balance".
      if (quote.toCurrency !== WALLET_CURRENCY) {
        throw new StoreError(
          409,
          `钱包仅支持 ${WALLET_CURRENCY} 结算，请选择其他支付方式`,
          'currency.payment_method_unsupported',
        );
      }
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
      tx.publish('order.paid', { orderId: paid.name, userId });
      return toOrder(paid);
    });
    return { order, nextPath: '/account/services' };
  }

  // 外部支付：创建订单 + 支付记录，由网关结算回调发布 order.paid。
  if (!input.providerId || !input.paymentMethod) throw new StoreError(400, '请选择支付方式');
  const reserved = await runTransaction(async (tx) => {
    const quote = await quoteSettlement(context(), product.currency, unit);
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
    // 已暂停（到期暂停）的服务：补费后调上游 resume 并恢复为 ACTIVE。resume 是**外部
    // 副作用**，失败必须抛出（不落 ACTIVE、不置幂等标记），否则会出现「平台已恢复、
    // 上游仍暂停」且不可重试。应在写入到期时间之前完成。
    const wasSuspended = service.status === 'SUSPENDED';
    if (wasSuspended) {
      await applyServiceLifecycleAction(service, 'resume');
    }
    // M-3 + M-4：到期时间与幂等标记在**同一事务**内落库，二者要么都生效要么都不生效，
    // 既避免「续费开始时的陈旧整行快照覆盖并发写入」，也避免「已顺延但标记丢失 → 重试
    // 再顺延一次」。标记在外部钩子成功后才写，因此失败可重试。
    //
    // 注：`expiresAt` 未声明为索引字段（无需查询），内核 `updateWhere` 不接受它，所以
    // 这里在事务内**重新读取当前行**再整行写回，既携带 `expiresAt` 又不会用续费开始时的
    // 陈旧快照覆盖这段时间内并发写入的 runtime 等字段。
    if (rawLine) {
      rawLine['previousExpiresAt'] = service.expiresAt ? service.expiresAt.toISOString() : null;
      rawLine['previousState'] = service.status;
      rawLine['renewalApplied'] = true;
    }
    await runTransaction(async (tx) => {
      const latestInstance = await tx.extensions.get<StoreServiceInstanceData>(
        serviceInstanceModel,
        service.id,
      );
      if (!latestInstance) return;
      const latest = toServiceInstanceData(toService(latestInstance));
      await tx.extensions.update<StoreServiceInstanceData>(serviceInstanceModel, service.id, {
        ...latest,
        expiresAt: nextExpiry.toISOString(),
        expiresAtMs: nextExpiry.getTime(),
        // 重置到期阶段与失败计数：续费后应从头重走提醒/暂停，且不继承上一次到期的失败次数。
        expiryStage: null,
        expiryAttempts: 0,
        expiryLastError: null,
        ...(wasSuspended ? { state: 'ACTIVE' } : {}),
      });
      if (rawLine) {
        await tx.extensions.update<StoreOrderData>(orderModel, orderId, {
          ...record.spec,
          items: { items: rawItems },
        });
      }
    });
    // 续费回调：通知提供方到期时间已推进（尽力而为，失败不阻断续费）。失败不阻断，但
    // 记录到 runtime 以便对账/排查（不改 state，不影响续费结果）。
    const { notifyServiceRenewal } = await import('./fulfillment');
    const { readServiceSelection } = await import('./changes');
    const selection = readServiceSelection(service);
    await notifyServiceRenewal(
      { ...service, expiresAt: nextExpiry },
      {
        newExpiresAt: nextExpiry.toISOString(),
        months,
        ...(selection ? { selection } : {}),
      },
    ).catch(async (error) => {
      const message = messageOf(error);
      logger().warn(`store: renewal provider hook failed for ${service.id}: ${message}`);
      await recordRenewalNotifyFailure(service, message);
    });
    logger().info(`store: renewed service ${service.id} to ${nextExpiry.toISOString()}`);
    // 续费成功通知用户（幂等键按订单+服务，重放合并为一条）。
    await notifyUser({
      userId: service.userId,
      type: 'service.renewed',
      title: '服务续费成功',
      body: `「${service.productName}」已续费 ${months} 个月，新的到期时间为 ${nextExpiry.toISOString().slice(0, 10)}。`,
      link: `/account/services/${service.id}`,
      data: { serviceId: service.id, orderId, expiresAt: nextExpiry.toISOString() },
      status: 'success',
      dedupeKey: `store:renew:${orderId}:${service.id}`,
    });
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
      // 回滚到期阶段（连同失败计数），使服务按恢复后的到期时间重新走一遍提醒/暂停。
      expiryStage: null,
      expiryAttempts: 0,
      expiryLastError: null,
    });
    logger().info(`store: reversed renewal for service ${service.id}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}

/**
 * 记录一次「续费后上游通知失败」到 `runtime`（不改 state，不阻断续费）。默认决策 B：
 * 续费以上游确认为准会造成强一致耦合，本步仅在 runtime 留痕供对账/排查。
 *
 * `runtime` 未声明为索引字段，内核 `updateWhere` 不接受它，因此重新读取当前行后整行
 * 写回（避免用续费前的陈旧快照覆盖刚写入的 expiresAt/expiryStage）。
 */
async function recordRenewalNotifyFailure(service: { id: string }, message: string): Promise<void> {
  try {
    const current = await getService(service.id);
    if (!current) return;
    const base =
      current.runtime && typeof current.runtime === 'object'
        ? (current.runtime as Record<string, unknown>)
        : {};
    await replaceServiceInstance(current.id, {
      ...toServiceInstanceData(current),
      runtime: {
        ...base,
        renewalNotifyError: message,
        renewalNotifyFailedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger().warn(
      `store: failed to record renewal notify failure for ${service.id}: ${messageOf(error)}`,
    );
  }
}

/** 判断订单是否包含续费行（履约调度器据此决定是否跳过 provision）。 */
export function hasRenewalLine(order: { items: unknown }): boolean {
  return stockItems(order).some((line) => Boolean(line.renewalServiceId));
}
