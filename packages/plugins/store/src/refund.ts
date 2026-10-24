import type { HttpRequest } from '@stackpanel/sdk';
import { extensions, logger, runTransaction } from './context';
import { StoreError, stockItems } from './errors';
import { getOrder } from './repository';
import type { OrderRecord } from './repository';
import { orderModel, productModel, deliveryTaskModel, serviceInstanceModel, refundRequestModel } from './data';
import { refundOrderSchema } from './utils';
import { notifyAdmins, notifyUser } from './notifications';
import { formatStoreMoney } from './currency';

/**
 * 退款（refund）。
 *
 * 魔方 V10 的交易流水可删改、可退款。本实现把「已支付订单」退回用户钱包：
 * 1) 原子把订单状态 PAID → REFUNDED（并发下只有一次生效）；
 * 2) 按结算币种把金额退回用户钱包（账本 `ORDER_REFUND` 幂等，重复调用不重复入账）；
 * 3) 回补非续费行的库存（续费行不占库存）。
 *
 * 退款不自动终止交付物：云服务器是否随之释放取决于运营策略，管理员可另行
 * 经 `updateService`/生命周期动作处理。
 *
 * 全额退款（`amount` 缺省或等于结算金额）会回补非续费行库存，并**撤销**续费行
 * 顺延的到期时间（防止「续费→退款」白拿时长）。部分退款只退回金额：不动物库存
 * 亦不回退时长，且订单即进入终态（不可再次退款）。
 */

/** 退款业务引用类型（账本幂等键）。 */
const REFUND_REFERENCE = 'ORDER_REFUND';

/** 可退款的订单状态。 */
const REFUNDABLE_STATES = new Set(['PAID', 'PARTIALLY_REFUNDED']);

interface RefundRequestData {
  orderId: string;
  userId: string;
  amount: number;
  currency: string;
  reason: string | null;
  state: string;
  reviewerId: string | null;
  reviewReason: string | null;
  failureReason: string | null;
  destination: string;
  idempotencyKey: string | null;
}

/**
 * 订单是否为「合作方预付」（SP v1 出口经 `CommerceOperations.createOrder` 建单）：
 * 此类订单平台从未经支付渠道实际收款，退款入账会给买家凭空铸造钱包余额。
 */
function isPartnerPrepaidOrder(order: OrderRecord): boolean {
  const items = order.items as { settlement?: unknown } | null;
  return items?.settlement === 'partner_prepaid';
}

export async function refundOrder(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  if (!id) throw new StoreError(400, '缺少 ID');
  const parsed = refundOrderSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  const actorId = req.user?.id;

  const order = await getOrder(id);
  if (!order) throw new StoreError(404, '订单不存在');
  if (!REFUNDABLE_STATES.has(order.status)) throw new StoreError(409, '订单不可退款');
  // 合作方预付订单（SP v1 出口建单）平台从未实际收款，退款入账会凭空铸造钱包余额。
  if (isPartnerPrepaidOrder(order)) {
    throw new StoreError(409, '该订单为合作方预付，不支持钱包退款');
  }

  // Product policy: every approved refund is credited to the user's
  // StackPanel platform balance. It is deliberately not an external
  // gateway refund and must never be described as money returned to a bank,
  // Alipay, WeChat, or another real-world account.

  const amount = resolveRefundAmount(order, parsed.data.amount);
  if (amount <= 0) throw new StoreError(400, '退款金额无效');
  const refundRequestId = typeof (req.body as { refundRequestId?: unknown } | null)?.refundRequestId === 'string'
    ? (req.body as { refundRequestId: string }).refundRequestId
    : null;
  const completedRefunds = refundRequestId
    ? await extensions().listAll<RefundRequestData>(refundRequestModel, { where: { orderId: { eq: id } } })
    : [];
  const refundedBefore = completedRefunds.filter(r => r.spec.state === 'SUCCEEDED').reduce((sum, r) => sum + r.spec.amount, 0);
  const isFull = refundedBefore + amount >= order.settlementTotal;

  const reason = parsed.data.reason;
  await runTransaction(async (tx) => {
    const { updated } = await tx.extensions.updateWhere(
      orderModel,
      { name: { eq: id }, state: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
      { state: { set: isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } },
    );
    if (updated === 0) throw new StoreError(409, '订单状态已变更');
    const tasks = await tx.extensions.listAll<{ state: string }>(deliveryTaskModel, { where: { orderId: { eq: id } } });
    if (tasks.some(task => ['RUNNING', 'REQUIRES_RECONCILIATION'].includes(task.spec.state))) {
      throw new StoreError(409, '开通结果尚未确认，请先核对上游状态再退款');
    }
    const services = await tx.extensions.listAll<{ state: string; providerServiceId: string | null }>(serviceInstanceModel, { where: { orderId: { eq: id } } });
    if (services.some(service => service.spec.state === 'PROVISIONING' && service.spec.providerServiceId)) throw new StoreError(409, '上游仍在开通中，请先确认结果再退款');
    for (const state of ['AWAITING_APPROVAL', 'PROVISIONING']) {
      await tx.extensions.updateWhere(serviceInstanceModel, { orderId: { eq: id }, state: { eq: state }, providerServiceId: { eq: null } }, { state: { set: 'TERMINATED' } });
    }
    await tx.extensions.updateWhere(deliveryTaskModel,
      { orderId: { eq: id }, state: { eq: 'PENDING' } }, { state: { set: 'CANCELLED' } });
    await tx.extensions.updateWhere(deliveryTaskModel,
      { orderId: { eq: id }, state: { eq: 'AWAITING_APPROVAL' } }, { state: { set: 'CANCELLED' } });
    await tx.wallet.credit(order.userId, amount, order.settlementCurrency, {
      type: 'ORDER_REFUND',
      referenceType: REFUND_REFERENCE,
      // Legacy direct admin path is one-shot per order. User-reviewed requests
      // use the request id as their independent ledger idempotency key.
      referenceId: refundRequestId ?? id,
      note: actorId
        ? `退款 订单 ${id}（操作人 ${actorId}）${reason ? `｜${reason}` : ''}`
        : `退款 订单 ${id}${reason ? `｜${reason}` : ''}`,
    });
    // 仅全额退款回补库存：非续费、非变配行才占用库存（变配订单从未 reserve）。
    if (isFull) {
      for (const line of stockItems(order)) {
        if (line.renewalServiceId || line.changeServiceId) continue;
        await tx.extensions.updateWhere(
          productModel,
          { name: { eq: line.productId } },
          { stock: { inc: line.quantity } },
        );
      }
    }
    // W1（审计 F-3）：`order.refunded` 必须与退款状态同事务落库——发布在事务外时，
    // 提交成功但进程在 publish 前崩溃会永久丢失该事实。
    // `full` 让下游能区分「整单撤销」与「部分退款」：推广佣金只在整单撤销时
    // 全额追回，部分退款扣回比例如会让佣金规则变成一团算术，且难以向用户解释。
    tx.publish('order.refunded', { orderId: id, amount, userId: order.userId, full: isFull });
  });

  // 全额退款：撤销续费行顺延的到期时间（best-effort，失败不影响退款本身）。
  if (isFull) {
    const { reverseRenewalOrder } = await import('./renewal');
    await reverseRenewalOrder(id).catch((error) => {
      logger().warn(`store: reverse renewal failed for order ${id}: ${messageOf(error)}`);
    });
    const { reverseChangeOrder } = await import('./changes');
    await reverseChangeOrder(id).catch((error) => {
      logger().warn(`store: reverse change failed for order ${id}: ${messageOf(error)}`);
    });
  }

  // `order.refunded` 已在退款事务内发布（W1，审计 F-3）。
  await notifyUser({
    userId: order.userId,
    type: 'order.refunded',
    title: '订单已退款',
    body: `订单 ${id} 已退款 ${formatMinor(amount, order.settlementCurrency)} 到你的平台余额。该金额不会退回真实支付账户。`,
    link: `/account/orders`,
    data: { orderId: id, amount, currency: order.settlementCurrency, full: isFull },
    status: 'success',
    dedupeKey: `store:order:${id}:refunded`,
  });
  const updated = await getOrder(id);
  return { order: updated, refunded: amount, currency: order.settlementCurrency };
}

/** 用户申请退款；申请本身不改订单、不返款，避免申请即产生资金事实。 */
export async function createRefundRequest(req: HttpRequest): Promise<unknown> {
  const orderId = req.params['id'];
  const userId = req.user?.id;
  if (!orderId || !userId) throw new StoreError(400, '缺少订单或用户身份');
  const parsed = refundOrderSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new StoreError(400, '请求参数无效');
  const order = await getOrder(orderId);
  if (!order || order.userId !== userId) throw new StoreError(404, '订单不存在');
  if (!['PAID', 'PARTIALLY_REFUNDED'].includes(order.status)) throw new StoreError(409, '只有已付款订单可以申请退款');
  if (isPartnerPrepaidOrder(order)) throw new StoreError(409, '该订单不是平台收款订单');
  const existing = await extensions().listAll<{ orderId: string; userId: string; amount: number; state: string; reason: string | null }>(refundRequestModel, { where: { orderId: { eq: orderId }, userId: { eq: userId } } });
  const activeRequest = existing.find(r => ['PENDING', 'PROCESSING'].includes(r.spec.state));
  if (activeRequest) {
    return {
      request: {
        id: activeRequest.name,
        orderId,
        amount: activeRequest.spec.amount,
        currency: order.settlementCurrency,
        status: activeRequest.spec.state,
        reason: activeRequest.spec.reason ?? null,
      },
      idempotent: true,
    };
  }
  const occupied = existing.filter(r => ['PENDING', 'PROCESSING', 'SUCCEEDED'].includes(r.spec.state)).reduce((sum, r) => sum + r.spec.amount, 0);
  const remaining = order.settlementTotal - occupied;
  if (remaining <= 0) throw new StoreError(409, '订单没有可退余额');
  const amount = parsed.data.amount === undefined ? remaining : parsed.data.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) throw new StoreError(400, '退款金额超过可退余额');
  const request = await extensions().create<RefundRequestData>(refundRequestModel, {
    orderId, userId, amount, currency: order.settlementCurrency,
    reason: parsed.data.reason ?? null, state: 'PENDING', destination: 'WALLET',
    reviewerId: null, reviewReason: null, failureReason: null, idempotencyKey: null,
  });
  await notifyAdmins({ type: 'order.refund.requested', title: '新的退款申请', body: `用户 ${userId} 申请订单 ${orderId} 退款。`, link: '/admin/plugin/store/refunds', data: { requestId: request.name, orderId, amount } });
  return { request: { id: request.name, orderId, amount, currency: order.settlementCurrency, status: 'PENDING', reason: parsed.data.reason ?? null } };
}

export async function listRefundRequests(req: HttpRequest, admin: boolean): Promise<unknown> {
  const where = admin ? undefined : { userId: { eq: req.user?.id ?? '' } };
  const rows = await extensions().listAll<{ orderId: string; userId: string; amount: number; currency: string; reason: string | null; state: string; reviewerId: string | null; reviewReason: string | null; failureReason: string | null; destination: string }>(refundRequestModel, { ...(where ? { where } : {}) });
  return { requests: rows.map(row => ({ id: row.name, ...row.spec })) };
}

export async function reviewRefundRequest(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  const reviewerId = req.user?.id;
  if (!id || !reviewerId) throw new StoreError(400, '缺少申请或审核人');
  const body = req.body as { decision?: unknown; reason?: unknown };
  const decision = body?.decision === 'approve' ? 'approve' : body?.decision === 'reject' ? 'reject' : null;
  if (!decision) throw new StoreError(400, '审核结果无效');
  const request = await extensions().get<RefundRequestData>(refundRequestModel, id);
  if (!request) throw new StoreError(404, '退款申请不存在');
  if (request.spec.state !== 'PENDING') throw new StoreError(409, '退款申请已处理');
  if (decision === 'reject') {
    await extensions().update<RefundRequestData>(refundRequestModel, id, { ...request.spec, state: 'REJECTED', reviewerId, reviewReason: typeof body.reason === 'string' ? body.reason.slice(0, 191) : '管理员拒绝', failureReason: null });
    await notifyUser({ userId: request.spec.userId, type: 'order.refund.rejected', title: '退款申请未通过', body: '管理员未批准本次退款申请。', link: '/account/orders', data: { requestId: id }, dedupeKey: `store:refund:${id}:rejected` });
    return { request: { id, status: 'REJECTED' } };
  }
  const claimed = await runTransaction(async tx => {
    const current = await tx.extensions.get<RefundRequestData>(refundRequestModel, id);
    if (!current || current.spec.state !== 'PENDING') return false;
    const result = await tx.extensions.updateWhere(refundRequestModel, { name: { eq: id }, state: { eq: 'PENDING' } }, { state: { set: 'PROCESSING' }, reviewerId: { set: reviewerId } });
    return result.updated === 1;
  });
  if (!claimed) throw new StoreError(409, '退款申请已被其他管理员处理');
  try {
    // 目前唯一有确定账本语义的是平台钱包；外部支付必须待 provider refund 契约接入后才允许批准。
    const result = await refundOrder({ params: { id: request.spec.orderId }, body: { amount: request.spec.amount, reason: request.spec.reason, refundRequestId: id }, user: req.user } as never);
    await extensions().update<RefundRequestData>(refundRequestModel, id, { ...request.spec, state: 'SUCCEEDED', reviewerId, failureReason: null });
    await notifyUser({ userId: request.spec.userId, type: 'order.refund.succeeded', title: '退款已到账', body: `退款已退入 StackPanel 平台余额，不会退回真实支付账户。`, link: '/account/orders', data: { requestId: id, amount: request.spec.amount, destination: 'PLATFORM_WALLET' }, dedupeKey: `store:refund:${id}:succeeded` });
    return { request: { id, status: 'SUCCEEDED' }, result };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '退款执行失败';
    await extensions().update<RefundRequestData>(refundRequestModel, id, { ...request.spec, state: 'FAILED', reviewerId, failureReason: reason.slice(0, 191) });
    await notifyUser({ userId: request.spec.userId, type: 'order.refund.failed', title: '退款处理失败', body: '退款未完成，请联系管理员重试。', link: '/account/orders', data: { requestId: id }, dedupeKey: `store:refund:${id}:failed` });
    throw new StoreError(409, '退款处理失败，请检查订单和履约状态后重试');
  }
}

/** 金额格式化（最小单位 → 本地化货币字符串，按币种小数位）。退款通知展示用。 */
function formatMinor(amount: number, currency: string): string {
  return formatStoreMoney(amount, currency);
}

/** 解析退款金额：显式 amount 优先，否则全额（结算金额）。越界即拒绝。 */
function resolveRefundAmount(order: OrderRecord, requested: number | undefined): number {
  const full = order.settlementTotal;
  if (requested === undefined) return full;
  if (!Number.isInteger(requested) || requested <= 0) throw new StoreError(400, '退款金额无效');
  if (requested > full) throw new StoreError(400, '退款金额超过订单金额');
  return requested;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '未知错误';
}
