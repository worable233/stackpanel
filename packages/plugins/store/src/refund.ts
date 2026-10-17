import type { HttpRequest } from '@stackpanel/sdk';
import { logger, runTransaction } from './context';
import { StoreError, stockItems } from './errors';
import { getOrder } from './repository';
import type { OrderRecord } from './repository';
import { orderModel, productModel } from './data';
import { refundOrderSchema } from './utils';
import { notifyUser } from './notifications';
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
const REFUNDABLE_STATES = new Set(['PAID']);

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

  const amount = resolveRefundAmount(order, parsed.data.amount);
  if (amount <= 0) throw new StoreError(400, '退款金额无效');
  const isFull = amount === order.settlementTotal;

  const reason = parsed.data.reason;
  await runTransaction(async (tx) => {
    const { updated } = await tx.extensions.updateWhere(
      orderModel,
      { name: { eq: id }, state: { eq: 'PAID' } },
      { state: { set: 'REFUNDED' } },
    );
    if (updated === 0) throw new StoreError(409, '订单状态已变更');
    await tx.wallet.credit(order.userId, amount, order.settlementCurrency, {
      type: 'ORDER_REFUND',
      referenceType: REFUND_REFERENCE,
      // 账本以 (referenceType, referenceId) 唯一约束做幂等；订单一旦退款即终态，
      // 故用订单号即可保证同一订单不会重复入账。
      referenceId: id,
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
    tx.publish('order.refunded', { orderId: id, amount, userId: order.userId });
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
    body: `订单 ${id} 已退款 ${formatMinor(amount, order.settlementCurrency)} 到你的钱包。`,
    link: `/account/orders`,
    data: { orderId: id, amount, currency: order.settlementCurrency, full: isFull },
    status: 'success',
    dedupeKey: `store:order:${id}:refunded`,
  });
  const updated = await getOrder(id);
  return { order: updated, refunded: amount, currency: order.settlementCurrency };
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
