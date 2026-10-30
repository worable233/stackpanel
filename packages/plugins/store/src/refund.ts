import type { HttpRequest } from '@stackpanel/sdk';
import { context, extensions, logger, runTransaction } from './context';
import { StoreError, stockItems } from './errors';
import { getOrder, getProduct, getService } from './repository';
import type { OrderRecord, ServiceInstanceRecord } from './repository';
import { orderModel, productModel, deliveryTaskModel, serviceInstanceModel, refundRequestModel } from './data';
import { refundOrderSchema } from './utils';
import { notifyAdmins, notifyUser } from './notifications';
import { formatStoreMoney } from './currency';
import { providerForProduct } from './fulfillment';
import { refundPolicy } from './settings';
import { computeRefundAmount, refundWindowEndsAt } from './refund-policy';
import type { RefundPolicy } from './refund-policy';

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
  /** 实例页发起的申请带服务 id；订单页发起为 null。 */
  serviceId: string | null;
  /** 申请时是否已把实例关机。 */
  suspendApplied: boolean;
  /** 审核通过后是否已向上游提交停用申请。 */
  terminateApplied: boolean;
  /** 停服失败原因（钱已退但机器没停时留给运营的手工任务）。 */
  terminateError: string | null;
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
  const attestedNoUpstreamInstance = parsed.data.confirmNoUpstreamInstance === true;
  await runTransaction(async (tx) => {
    // Every refusal is decided before the first write: relying on a rollback to
    // undo the order-state flip makes the outcome depend on transaction semantics
    // rather than on the rule itself.
    const tasks = await tx.extensions.listAll<{ state: string }>(deliveryTaskModel, { where: { orderId: { eq: id } } });
    // `RUNNING` is a live attempt: it may be creating the upstream object right
    // now, so no operator statement can make a refund safe.
    if (tasks.some(task => task.spec.state === 'RUNNING')) {
      throw new StoreError(409, '开通仍在执行中，请等待结果再退款', 'store.refund.provisioning_running');
    }
    const reconciling = tasks.filter(task => task.spec.state === 'REQUIRES_RECONCILIATION');
    const services = await tx.extensions.listAll<{ state: string; providerServiceId: string | null }>(serviceInstanceModel, { where: { orderId: { eq: id } } });
    if (services.some(service => service.spec.state === 'PROVISIONING' && service.spec.providerServiceId)) throw new StoreError(409, '上游仍在开通中，请先确认结果再退款', 'store.refund.provisioning_running');
    if (reconciling.length > 0) {
      // An upstream id is evidence the remote object exists. No attestation can
      // override evidence — only an operator statement about an *empty* upstream.
      if (services.some(service => service.spec.providerServiceId)) {
        throw new StoreError(409, '该订单已有上游实例，请先终止实例再退款', 'store.refund.upstream_instance_exists');
      }
      if (!attestedNoUpstreamInstance) {
        throw new StoreError(
          409,
          '开通结果尚未确认，请先核对上游实例；确认无实例后可授权退款',
          'store.refund.needs_upstream_attestation',
        );
      }
    }

    const { updated } = await tx.extensions.updateWhere(
      orderModel,
      { name: { eq: id }, state: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
      { state: { set: isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } },
    );
    if (updated === 0) throw new StoreError(409, '订单状态已变更');
    for (const state of ['AWAITING_APPROVAL', 'PROVISIONING']) {
      await tx.extensions.updateWhere(serviceInstanceModel, { orderId: { eq: id }, state: { eq: state }, providerServiceId: { eq: null } }, { state: { set: 'TERMINATED' } });
    }
    await tx.extensions.updateWhere(deliveryTaskModel,
      { orderId: { eq: id }, state: { eq: 'PENDING' } }, { state: { set: 'CANCELLED' } });
    await tx.extensions.updateWhere(deliveryTaskModel,
      { orderId: { eq: id }, state: { eq: 'AWAITING_APPROVAL' } }, { state: { set: 'CANCELLED' } });
    // Closing the reconcile-blocked tasks is the point of the attestation: leaving
    // them in `REQUIRES_RECONCILIATION` would keep the order out of every later
    // settlement and the operator out of the refund flow forever.
    if (attestedNoUpstreamInstance) {
      await tx.extensions.updateWhere(deliveryTaskModel,
        { orderId: { eq: id }, state: { eq: 'REQUIRES_RECONCILIATION' } }, { state: { set: 'CANCELLED' } });
    }
    await tx.wallet.credit(order.userId, amount, order.settlementCurrency, {
      type: 'ORDER_REFUND',
      referenceType: REFUND_REFERENCE,
      // Legacy direct admin path is one-shot per order. User-reviewed requests
      // use the request id as their independent ledger idempotency key.
      referenceId: refundRequestId ?? id,
      note: actorId
        ? `退款 订单 ${id}（操作人 ${actorId}）${reason ? `｜${reason}` : ''}${attestedNoUpstreamInstance ? '｜运营确认上游无实例' : ''}`
        : `退款 订单 ${id}${reason ? `｜${reason}` : ''}${attestedNoUpstreamInstance ? '｜运营确认上游无实例' : ''}`,
    });
    // 直接退款（跳过申请）必须顺手关掉同一订单上还开着的申请：否则运营商看着
    // 「退款申请」列表里那几条永远 PENDING，点批准只会得到「订单不可退款」，
    // 一笔钱在账上已经退完了，队列里却永远清不掉。
    if (!refundRequestId) {
      const openRequests = await tx.extensions.listAll<RefundRequestData>(refundRequestModel, {
        where: { orderId: { eq: id } },
      });
      for (const request of openRequests) {
        if (request.spec.state !== 'PENDING' && request.spec.state !== 'FAILED') continue;
        await tx.extensions.update<RefundRequestData>(refundRequestModel, request.name, {
          ...request.spec,
          state: 'SUCCEEDED',
          reviewerId: actorId ?? null,
          reviewReason: '运营直接退款，无需单独审核',
          failureReason: null,
        });
      }
    }
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
    serviceId: null, suspendApplied: false, terminateApplied: false, terminateError: null,
  });
  await notifyAdmins({ type: 'order.refund.requested', title: '新的退款申请', body: `用户 ${userId} 申请订单 ${orderId} 退款。`, link: '/admin/plugin/store/refunds', data: { requestId: request.name, orderId, amount } });
  return { request: { id: request.name, orderId, amount, currency: order.settlementCurrency, status: 'PENDING', reason: parsed.data.reason ?? null } };
}

/* ---------------------- 实例页退款（服务级申请） ---------------------- */

/** 服务级退款资格：政策窗口 + 政策金额 + 是否已提交过申请。 */
export interface ServiceRefundEligibility {
  eligible: boolean;
  /** 不可申请时的原因（直接展示给客户）。 */
  reason: string | null;
  orderId: string | null;
  orderAmount: number;
  /** 政策允许退给客户的最大金额（已扣手续费）。 */
  refundableAmount: number;
  currency: string;
  /** 申请截止时刻 ISO；null 表示不设截止（永久可申请）。 */
  windowEndsAt: string | null;
  policy: RefundPolicy;
}

/** 已占用订单退款额度的状态：这些状态下不允许再提一笔。 */
const OCCUPYING_REFUND_STATES = new Set(['PENDING', 'PROCESSING', 'FAILED', 'SUCCEEDED']);

/**
 * 计算一个服务当前的退款资格。
 *
 * 资格查询与提交申请共用同一份推导：展示给客户的可退金额和最后真正退的金额
 * 必须同源，否则就是「页面写 ¥47.60、实际退 ¥38」这类最伤信任的差异。
 */
async function evaluateServiceRefund(service: ServiceInstanceRecord): Promise<ServiceRefundEligibility> {
  const policy = await refundPolicy();
  const order = service.orderId ? await getOrder(service.orderId) : null;
  const orderAmount = order ? order.settlementTotal : service.amount;
  const currency = order ? order.settlementCurrency : service.currency;
  // 窗口起点：开通时间最接近付款，且开通在前才可能退款；缺失时退化到订单创建时间。
  const baseDate = service.provisionedAt ?? order?.createdAt ?? service.createdAt;
  const baseMs = baseDate ? baseDate.getTime() : null;
  const windowEnd = refundWindowEndsAt(baseMs, policy);
  const nowMs = Date.now();
  const refundableAmount = computeRefundAmount({
    policy,
    orderAmount,
    periodStartMs: service.provisionedAt ? service.provisionedAt.getTime() : baseMs,
    periodEndMs: service.expiresAt ? service.expiresAt.getTime() : null,
    nowMs,
  });
  const skeleton: Omit<ServiceRefundEligibility, 'eligible' | 'reason'> = {
    orderId: service.orderId,
    orderAmount,
    refundableAmount,
    currency,
    windowEndsAt: windowEnd ? new Date(windowEnd).toISOString() : null,
    policy,
  };
  const deny = (reason: string): ServiceRefundEligibility => ({ ...skeleton, eligible: false, reason });
  if (!policy.enabled) return deny('当前暂未开放退款');
  if (!order || !service.orderId) return deny('该服务没有关联订单，无法自助退款');
  if (order.userId !== service.userId) return deny('订单归属不一致，请联系客服');
  if (!['PAID', 'PARTIALLY_REFUNDED'].includes(order.status)) return deny('订单当前状态不可退款');
  if (isPartnerPrepaidOrder(order)) return deny('该订单不是平台收款订单');
  if (service.status === 'TERMINATED') return deny('服务已终止');
  if (service.status === 'PENDING_PROVISION' || service.status === 'PROVISIONING') {
    return deny('服务正在开通中，请稍后再试');
  }
  if (policy.windowDays === 0) return deny('该服务不支持退款');
  if (windowEnd !== null && nowMs > windowEnd) return deny('已超过可申请退款的时间窗口');
  const requests = await extensions().listAll<RefundRequestData>(refundRequestModel, {
    where: { orderId: { eq: order.id } },
  });
  const occupied = requests
    .filter((r) => OCCUPYING_REFUND_STATES.has(r.spec.state))
    .reduce((sum, r) => sum + r.spec.amount, 0);
  if (policy.oncePerOrder && requests.some((r) => OCCUPYING_REFUND_STATES.has(r.spec.state))) {
    return deny('该订单已提交过退款申请');
  }
  if (occupied >= orderAmount && policy.amountMode === 'full') return deny('订单没有可退余额');
  if (refundableAmount <= 0) return deny('按当前退款政策，可退金额为 0');
  return { ...skeleton, eligible: true, reason: null };
}

/** 实例页读退款资格（前端据此决定是否显示入口与金额）。 */
export async function getServiceRefundEligibility(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  const userId = req.user?.id;
  if (!id || !userId) throw new StoreError(400, '缺少服务或用户身份');
  const service = await getService(id);
  if (!service || service.userId !== userId) throw new StoreError(404, '服务不存在');
  const eligibility = await evaluateServiceRefund(service);
  const requests = service.orderId
    ? await extensions().listAll<RefundRequestData>(refundRequestModel, {
        where: { orderId: { eq: service.orderId } },
      })
    : [];
  const latest = requests
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return {
    serviceId: id,
    ...eligibility,
    request: latest
      ? {
          id: latest.name,
          state: latest.spec.state,
          amount: latest.spec.amount,
          serviceId: latest.spec.serviceId,
          reason: latest.spec.reason,
          reviewReason: latest.spec.reviewReason,
        }
      : null,
  };
}

/**
 * 从实例页提交退款申请。
 *
 * 顺序很关键：**先真的把实例停用，再落申请**。反过来的话，从「申请」到「停用」
 * 之间（以及停用失败时）客户仍旧白用着机器，而我们已经在流程里承诺了退款。
 * 停用是关机型（可逆），审核驳回后会自动恢复；不可逆的停用申请留到通过之后。
 */
export async function createServiceRefundRequest(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  const userId = req.user?.id;
  if (!id || !userId) throw new StoreError(400, '缺少服务或用户身份');
  const service = await getService(id);
  if (!service || service.userId !== userId) throw new StoreError(404, '服务不存在');
  const body = (req.body ?? {}) as { reason?: unknown };
  const eligibility = await evaluateServiceRefund(service);
  if (!eligibility.eligible) {
    throw new StoreError(409, `无法申请退款：${eligibility.reason ?? '不满足退款条件'}`);
  }
  const orderId = eligibility.orderId;
  if (!orderId) throw new StoreError(409, '该服务没有关联订单');
  const order = await getOrder(orderId);
  if (!order) throw new StoreError(404, '订单不存在');
  let suspendApplied = false;
  if (eligibility.policy.suspendOnRequest) {
    try {
      await runServiceLifecycle(service, 'suspend');
      suspendApplied = true;
      await extensions().updateWhere(
        serviceInstanceModel,
        { name: { eq: service.id } },
        { state: { set: 'SUSPENDED' } },
      );
    } catch (error) {
      // 停不掉就别建申请：申请存在但机器还在跑，是最坏的一种「已承诺未执行」。
      throw new StoreError(502, `实例停用失败，请稍后重试：${messageOf(error).slice(0, 120)}`);
    }
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : null;
  const request = await extensions().create<RefundRequestData>(refundRequestModel, {
    orderId,
    userId,
    amount: eligibility.refundableAmount,
    currency: eligibility.currency,
    reason: reason && reason.length > 0 ? reason : null,
    state: 'PENDING',
    destination: 'WALLET',
    reviewerId: null,
    reviewReason: null,
    failureReason: null,
    idempotencyKey: null,
    serviceId: service.id,
    suspendApplied,
    terminateApplied: false,
    terminateError: null,
  });
  await notifyAdmins({
    type: 'order.refund.requested',
    title: '新的退款申请',
    body: `用户 ${userId} 为服务「${service.productName}」申请退款 ${formatStoreMoney(eligibility.refundableAmount, eligibility.currency)}（实例已停用）。`,
    link: '/admin/plugin/store/refunds',
    data: { requestId: request.name, orderId, serviceId: service.id, amount: eligibility.refundableAmount },
  });
  await notifyUser({
    userId,
    type: 'order.refund.submitted',
    title: '退款申请已提交',
    body: `实例已停用，退款申请审核中。可退金额 ${formatStoreMoney(eligibility.refundableAmount, eligibility.currency)}，审核通过后进入平台余额。`,
    link: `/account/services`,
    data: { requestId: request.name, serviceId: service.id, amount: eligibility.refundableAmount },
    dedupeKey: `store:refund:${request.name}:created`,
  });
  return {
    request: {
      id: request.name,
      orderId,
      serviceId: service.id,
      amount: eligibility.refundableAmount,
      currency: eligibility.currency,
      status: 'PENDING',
      reason: request.spec.reason,
    },
    serviceSuspended: suspendApplied,
  };
}

/**
 * 在一个实例上执行上游生命周期动作（suspend / resume / terminate）。
 *
 * 与到期扫描同构：绑定了上游却解析不到提供方或钩子时必须抛错，绝不能静默当作
 * 成功——那会让「已停用」「已恢复」变成一句谎话。本地交付物无外部副作用，保持
 * no-op 成功。
 */
async function runServiceLifecycle(
  service: ServiceInstanceRecord,
  action: 'suspend' | 'resume' | 'terminate',
): Promise<void> {
  const product = await getProduct(service.productId);
  const provider = providerForProduct({
    providerId: service.providerId ?? product?.providerId ?? null,
    fulfillmentType: service.fulfillmentType,
  });
  const hook = provider
    ? action === 'suspend'
      ? provider.suspend
      : action === 'resume'
        ? provider.resume
        : provider.terminate
    : undefined;
  const expectsUpstream = Boolean(service.providerId || service.providerServiceId);
  if (!provider || !hook) {
    if (expectsUpstream) {
      throw new Error(
        `未找到可执行 ${action} 的上游提供方（providerId=${service.providerId ?? 'null'}）`,
      );
    }
    return;
  }
  await hook.call(provider, {
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
      expiresAt: service.expiresAt ? service.expiresAt.toISOString() : null,
    },
    secrets: context().secrets,
  });
}

/**
 * 审核驳回后恢复实例（申请时关过机才需要）。
 *
 * 恢复失败不回滚驳回结论：申请状态是人的决定，机器状态是运维事实。失败要留痕
 * 并通知运营，否则客户看到的是一台「被驳回但还停着」的机器。
 */
async function resumeServiceAfterReject(spec: RefundRequestData): Promise<void> {
  if (!spec.serviceId || !spec.suspendApplied) return;
  const service = await getService(spec.serviceId);
  if (!service || service.status === 'TERMINATED') return;
  try {
    await runServiceLifecycle(service, 'resume');
    await extensions().updateWhere(
      serviceInstanceModel,
      { name: { eq: service.id }, state: { eq: 'SUSPENDED' } },
      { state: { set: 'ACTIVE' } },
    );
  } catch (error) {
    const reason = messageOf(error).slice(0, 191);
    logger().warn(`store: refund rejected but resume failed for service ${service.id}: ${reason}`);
    await notifyAdmins({
      type: 'store.refund.resume-failed',
      title: '退款驳回后实例未恢复',
      body: `服务 ${service.productName}（${service.id}）恢复失败：${reason}。请手工开机。`,
      link: `/admin/plugin/store/services`,
      data: { serviceId: service.id, error: reason },
    });
  }
}

/**
 * 审核通过后向上游提交停用申请（不可逆）。
 *
 * 钱先退、机器后停：停服失败不能让客户拿不到已批准的钱。失败写回申请并通知运营，
 * 由人来决定是补刀还是换机。
 */
async function terminateServiceAfterApprove(
  spec: RefundRequestData,
  requestId: string,
): Promise<{ applied: boolean; error: string | null }> {
  if (!spec.serviceId) return { applied: false, error: null };
  // 政策在审核时才读：运营可能在客户提交后把「通过即停服」关掉，用申请时的快照
  // 会逆着最新政策动手。
  const policy = await refundPolicy();
  if (!policy.terminateOnApprove) return { applied: false, error: null };
  const service = await getService(spec.serviceId);
  if (!service) return { applied: false, error: null };
  if (service.status === 'TERMINATED') return { applied: true, error: null };
  try {
    await runServiceLifecycle(service, 'terminate');
    await extensions().updateWhere(
      serviceInstanceModel,
      { name: { eq: service.id } },
      { state: { set: 'TERMINATED' } },
    );
    return { applied: true, error: null };
  } catch (error) {
    const reason = messageOf(error).slice(0, 191);
    logger().warn(`store: refund ${requestId} approved but terminate failed for service ${service.id}: ${reason}`);
    await notifyAdmins({
      type: 'store.refund.terminate-failed',
      title: '退款已批准但上游停用失败',
      body: `服务 ${service.productName}（${service.id}）退款已退入余额，但上游停用失败：${reason}。请手工停用。`,
      link: `/admin/plugin/store/services`,
      data: { serviceId: service.id, requestId, error: reason },
    });
    return { applied: false, error: reason };
  }
}

export async function listRefundRequests(req: HttpRequest, admin: boolean): Promise<unknown> {
  const where = admin ? undefined : { userId: { eq: req.user?.id ?? '' } };
  const rows = await extensions().listAll<RefundRequestData>(refundRequestModel, { ...(where ? { where } : {}) });
  // 自愈：订单已经全额退款，申请却还挂着 PENDING（历史上跳过申请直接退款的路径
  // 就是这么留下的）。这种申请永远无法被审核（订单已退款 → 409），留在队列里只会
  // 让人以为有笔钱没处理。列表时顺手收尾一次，不需要人去库房改数据。
  const settled: typeof rows = [];
  for (const row of rows) {
    if (row.spec.state !== 'PENDING' && row.spec.state !== 'FAILED') {
      settled.push(row);
      continue;
    }
    const order = await getOrder(row.spec.orderId);
    if (order?.status !== 'REFUNDED') {
      settled.push(row);
      continue;
    }
    const next = {
      ...row.spec,
      state: 'SUCCEEDED',
      reviewReason: '订单已全额退款，申请自动关闭',
      failureReason: null,
    };
    await extensions().update<RefundRequestData>(refundRequestModel, row.name, next);
    settled.push({ ...row, spec: next });
  }
  return { requests: settled.map(row => ({ id: row.name, ...row.spec })) };
}

export async function reviewRefundRequest(req: HttpRequest): Promise<unknown> {
  const id = req.params['id'];
  const reviewerId = req.user?.id;
  if (!id || !reviewerId) throw new StoreError(400, '缺少申请或审核人');
  const body = req.body as { decision?: unknown; reason?: unknown; confirmNoUpstreamInstance?: unknown };
  // Operator attestation travels with the review decision: the refund path needs it
  // to act on an order whose delivery outcome can never be proven by the provider.
  const confirmNoUpstreamInstance = body?.confirmNoUpstreamInstance === true;
  const decision = body?.decision === 'approve' ? 'approve' : body?.decision === 'reject' ? 'reject' : null;
  if (!decision) throw new StoreError(400, '审核结果无效');
  const request = await extensions().get<RefundRequestData>(refundRequestModel, id);
  if (!request) throw new StoreError(404, '退款申请不存在');
  // A failed attempt is not a decision. The failure notification literally tells
  // the admin to retry, and the upstream attestation is part of that retry —
  // treating FAILED as terminal made the request permanently unreviewable.
  if (request.spec.state !== 'PENDING' && request.spec.state !== 'FAILED') {
    throw new StoreError(409, '退款申请已处理');
  }
  if (decision === 'reject') {
    await extensions().update<RefundRequestData>(refundRequestModel, id, { ...request.spec, state: 'REJECTED', reviewerId, reviewReason: typeof body.reason === 'string' ? body.reason.slice(0, 191) : '管理员拒绝', failureReason: null });
    // 申请时把实例关过机 → 驳回必须还回去。否则「拒绝退款」顺手把客户的服务停了。
    await resumeServiceAfterReject(request.spec);
    await notifyUser({ userId: request.spec.userId, type: 'order.refund.rejected', title: '退款申请未通过', body: request.spec.serviceId ? '管理员未批准本次退款申请，实例已恢复运行。' : '管理员未批准本次退款申请。', link: request.spec.serviceId ? '/account/services' : '/account/orders', data: { requestId: id, serviceId: request.spec.serviceId }, dedupeKey: `store:refund:${id}:rejected` });
    return { request: { id, status: 'REJECTED' } };
  }
  const claimed = await runTransaction(async tx => {
    const current = await tx.extensions.get<RefundRequestData>(refundRequestModel, id);
    // `FAILED` is a *retryable* outcome, not a decision: the failure notification
    // tells the admin to retry, and the attestation flow retries the very same
    // request. Claiming only from `PENDING` turned that into “已被其他管理员处理”.
    if (!current || (current.spec.state !== 'PENDING' && current.spec.state !== 'FAILED')) {
      return false;
    }
    // 只有 `indexes` 里声明的字段才是物理列；`reviewerId` 只存在于 spec，不能进
    // `updateWhere` 的 patch（内核会抛「不可更新的字段」，接口返回 422）。认领只抢占
    // `state` 列，审核人随最终整行 `update()` 落库。
    const result = await tx.extensions.updateWhere(refundRequestModel, { name: { eq: id }, state: { in: ['PENDING', 'FAILED'] } }, { state: { set: 'PROCESSING' } });
    return result.updated === 1;
  });
  if (!claimed) throw new StoreError(409, '退款申请已被其他管理员处理');
  try {
    // 目前唯一有确定账本语义的是平台钱包；外部支付必须待 provider refund 契约接入后才允许批准。
    // `reason` 在申请里可为 null，而 `refundOrderSchema.reason` 是可选字符串：
    // 原样透传 null 会让内层校验失败，把整笔退款误判为「请求参数无效」。
    const result = await refundOrder({ params: { id: request.spec.orderId }, body: { amount: request.spec.amount, ...(request.spec.reason ? { reason: request.spec.reason } : {}), refundRequestId: id, ...(confirmNoUpstreamInstance ? { confirmNoUpstreamInstance: true } : {}) }, user: req.user } as never);
    // 钱先进余额（客户优先），随后把上游停掉。停服失败不让退款翻回失败态：
    // 钱已经退了，把结论改成「失败」会让运营重复退款。失败只留痕并告警。
    const stop = await terminateServiceAfterApprove(request.spec, id);
    await extensions().update<RefundRequestData>(refundRequestModel, id, { ...request.spec, state: 'SUCCEEDED', reviewerId, reviewReason: confirmNoUpstreamInstance ? '运营确认上游无实例后授权退款' : request.spec.reviewReason, failureReason: null, terminateApplied: stop.applied, terminateError: stop.error });
    await notifyUser({ userId: request.spec.userId, type: 'order.refund.succeeded', title: '退款已到账', body: request.spec.serviceId ? `退款已退入 StackPanel 平台余额（不会退回真实支付账户），实例已按退款完成停用。` : `退款已退入 StackPanel 平台余额，不会退回真实支付账户。`, link: request.spec.serviceId ? '/account/services' : '/account/orders', data: { requestId: id, amount: request.spec.amount, destination: 'PLATFORM_WALLET', serviceId: request.spec.serviceId }, dedupeKey: `store:refund:${id}:succeeded` });
    return { request: { id, status: 'SUCCEEDED' }, result };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '退款执行失败';
    // Keep the stable code: the admin UI branches on it to ask for the operator's
    // "no upstream instance" attestation instead of showing a dead end.
    const code = error instanceof StoreError ? error.code : undefined;
    await extensions().update<RefundRequestData>(refundRequestModel, id, { ...request.spec, state: 'FAILED', reviewerId, failureReason: reason.slice(0, 191) });
    await notifyUser({ userId: request.spec.userId, type: 'order.refund.failed', title: '退款处理失败', body: '退款未完成，请联系管理员重试。', link: '/account/orders', data: { requestId: id }, dedupeKey: `store:refund:${id}:failed` });
    // 失败原因要透出可操作的业务信息（如「开通结果尚未确认」），否则管理员只能
    // 看到一句笼统提示，以为按钮点不动。
    throw new StoreError(409, `退款处理失败：${reason.slice(0, 191)}`, code);
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
