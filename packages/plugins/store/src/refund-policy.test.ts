import { describe, expect, it } from 'vitest';
import { computeRefundAmount, refundWindowEndsAt, DEFAULT_REFUND_POLICY } from './refund-policy';
import type { RefundPolicy } from './refund-policy';

const DAY = 86_400_000;
const policy = (patch: Partial<RefundPolicy> = {}): RefundPolicy => ({ ...DEFAULT_REFUND_POLICY, ...patch });

describe('退款窗口（refundWindowEndsAt）', () => {
  it('按天计算截止时刻', () => {
    const base = Date.UTC(2026, 0, 1);
    expect(refundWindowEndsAt(base, policy({ windowDays: 7 }))).toBe(base + 7 * DAY);
  });
  it('null 表示永久可申请（不设截止）', () => {
    expect(refundWindowEndsAt(Date.UTC(2026, 0, 1), policy({ windowDays: null }))).toBeNull();
  });
  it('0 天窗口的截止时刻就是起点本身（任何申请都超窗）', () => {
    const base = Date.UTC(2026, 0, 1);
    expect(refundWindowEndsAt(base, policy({ windowDays: 0 }))).toBe(base);
  });
  it('起点未知时不给截止时效（不因缺时间把人挡在门外）', () => {
    expect(refundWindowEndsAt(null, policy({ windowDays: 1 }))).toBeNull();
  });
});

describe('退款金额（computeRefundAmount）', () => {
  it('full 模式在窗口内退全额', () => {
    expect(
      computeRefundAmount({
        policy: policy({ amountMode: 'full' }),
        orderAmount: 7200,
        periodStartMs: 0,
        periodEndMs: 30 * DAY,
        nowMs: 10 * DAY,
      }),
    ).toBe(7200);
  });

  it('prorated 按未使用的服务时长占比', () => {
    // 月付 ¥72.00 用了 10 天 → 剩 20/30 → ¥48.00
    expect(
      computeRefundAmount({
        policy: policy({ amountMode: 'prorated' }),
        orderAmount: 7200,
        periodStartMs: 0,
        periodEndMs: 30 * DAY,
        nowMs: 10 * DAY,
      }),
    ).toBe(4800);
  });

  it('prorated 在到期后退 0（没有可退时长）', () => {
    expect(
      computeRefundAmount({
        policy: policy({ amountMode: 'prorated' }),
        orderAmount: 7200,
        periodStartMs: 0,
        periodEndMs: 30 * DAY,
        nowMs: 31 * DAY,
      }),
    ).toBe(0);
  });

  it('prorated 在开通前（时间未到）不超额退款', () => {
    expect(
      computeRefundAmount({
        policy: policy({ amountMode: 'prorated' }),
        orderAmount: 7200,
        periodStartMs: 10 * DAY,
        periodEndMs: 40 * DAY,
        nowMs: 0,
      }),
    ).toBe(7200);
  });

  it('没有账期信息时按全额处理（无依据不凭空扣款）', () => {
    expect(
      computeRefundAmount({
        policy: policy({ amountMode: 'prorated' }),
        orderAmount: 7200,
        periodStartMs: null,
        periodEndMs: null,
        nowMs: Date.now(),
      }),
    ).toBe(7200);
  });

  it('手续费按千分比扣除并向下取整', () => {
    // 7200 × (1 − 500/10000) = 6840
    expect(
      computeRefundAmount({
        policy: policy({ amountMode: 'full', feePercentBps: 500 }),
        orderAmount: 7200,
        periodStartMs: null,
        periodEndMs: null,
        nowMs: 0,
      }),
    ).toBe(6840);
  });

  it('手续费 100% 时退 0，永不为负', () => {
    expect(
      computeRefundAmount({
        policy: policy({ amountMode: 'full', feePercentBps: 10_000 }),
        orderAmount: 7200,
        periodStartMs: null,
        periodEndMs: null,
        nowMs: 0,
      }),
    ).toBe(0);
  });

  it('订单金额为 0 或负数时退 0', () => {
    for (const orderAmount of [0, -100]) {
      expect(
        computeRefundAmount({
          policy: policy({ amountMode: 'full' }),
          orderAmount,
          periodStartMs: null,
          periodEndMs: null,
          nowMs: 0,
        }),
      ).toBe(0);
    }
  });
});
