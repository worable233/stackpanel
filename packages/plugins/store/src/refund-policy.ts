/**
 * 退款政策的纯逻辑：时间窗口与金额推导。
 *
 * 政策本身存在 store settings（运营后台可配，见 `settings.ts`），这里只负责
 * 「给定政策 + 订单/服务事实，算出客户能拿回多少」。抽成纯函数是因为这些边界
 * 全是钱：0 天窗口（禁退）、永久窗口、按比例时剩余时间为负、手续费吃掉全部金额、
 * 一次性服务没有账期。这些都不该靠读代码猜。
 */

/** 退款政策（与 settings schema 同形）。 */
export interface RefundPolicy {
  /** 总开关。关掉后实例页不出现退款入口，接口也拒绝申请。 */
  enabled: boolean;
  /**
   * 付款后多少天内可申请：`null` = 永久可申请，`0` = 一律禁止。
   * 起点优先取订单付款时间，缺失时退化为服务开通时间。
   */
  windowDays: number | null;
  /** `full` = 窗口内全额；`prorated` = 按**未使用**的服务时长比例。 */
  amountMode: 'full' | 'prorated';
  /** 手续费千分比：最终退款 = 应退 × (1 − bps/10000)，向下取整。 */
  feePercentBps: number;
  /** 申请即停用实例（关机，可逆）。审核驳回后自动恢复。 */
  suspendOnRequest: boolean;
  /** 审核通过后向上游提交停用申请（不可逆）。 */
  terminateOnApprove: boolean;
  /** 同一订单只接受一次退款申请（防重复申请占位）。 */
  oncePerOrder: boolean;
}

/**
 * 默认政策：**关闭**。
 *
 * 退款是花钱的动作，默认必须是「运营显式开启」——一个升级带来默认开启的退款入口，
 * 等于给每个客户发一张自动退款券。
 */
export const DEFAULT_REFUND_POLICY: RefundPolicy = {
  enabled: false,
  windowDays: 7,
  amountMode: 'prorated',
  feePercentBps: 0,
  suspendOnRequest: true,
  terminateOnApprove: true,
  oncePerOrder: true,
};

const DAY_MS = 86_400_000;

/**
 * 窗口截止时刻（epoch 毫秒）。
 *
 * - `windowDays === null` → `null`，表示**永久**可申请；
 * - 起点未知 → `null`（不因为缺时间就把人挡在门外，仍由金额规则兜底）；
 * - `windowDays === 0` → 截止时刻等于起点，任何申请都超窗（由调用方判禁）。
 */
export function refundWindowEndsAt(baseMs: number | null, policy: RefundPolicy): number | null {
  if (policy.windowDays === null) return null;
  if (baseMs == null) return null;
  return baseMs + policy.windowDays * DAY_MS;
}

/**
 * 政策驱动的最小货币单位退款额（已扣手续费，永不为负）。
 *
 * `prorated` 的语义是「只为没用到的时间付钱」：剩余时长按账期占比折算；
 * 没有账期信息（一次性购买、或上游没给到期时间）时退回全额——因为没有依据
 * 证明「用了多少」，猜一个比例就是凭空扣客户的钱。
 */
export function computeRefundAmount(params: {
  policy: RefundPolicy;
  orderAmount: number;
  periodStartMs: number | null;
  periodEndMs: number | null;
  nowMs: number;
}): number {
  const { policy, orderAmount, periodStartMs, periodEndMs, nowMs } = params;
  if (!Number.isFinite(orderAmount) || orderAmount <= 0) return 0;
  let base = Math.floor(orderAmount);
  if (
    policy.amountMode === 'prorated' &&
    periodStartMs != null &&
    periodEndMs != null &&
    periodEndMs > periodStartMs
  ) {
    const total = periodEndMs - periodStartMs;
    const remaining = Math.min(Math.max(periodEndMs - nowMs, 0), total);
    base = Math.floor((base * remaining) / total);
  }
  const fee = Math.floor((base * policy.feePercentBps) / 10_000);
  return Math.max(0, base - fee);
}
