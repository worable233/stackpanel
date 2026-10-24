import { beforeEach, describe, expect, it } from 'vitest';
import type { PluginContext } from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';
import {
  applyDiscount,
  betterDiscount,
  effectiveGroupDiscount,
  MAX_DISCOUNT_PERCENT,
} from './discount';

/**
 * 折扣口径回归。
 *
 * 这组用例锁的不是「函数行为」，而是 #7 的核心不变量：**展示价与实付价必须由
 * 同一套规则算出**。此前折扣只在 orders.ts 生效，商品页/购物车/续费/变配/合作方
 * 下单各自按原价计算，同一件商品在不同入口能算出不同金额。
 *
 * 同时锁住两条边界，避免修「不一致」时引入新的定价事故：
 * - 折扣是**择一**不是叠加（否则多加一个权限组就能叠到离谱）；
 * - 折扣封顶 99%（否则配成 100 会把商品变成免费）。
 */

function ctxWithGroups(groups: Array<{ id: string; discount: number | null }>): PluginContext {
  return {
    auth: {
      listUserGroups: async () => groups,
    },
  } as unknown as PluginContext;
}

describe('applyDiscount', () => {
  it('无折扣或非正折扣时原样返回', () => {
    expect(applyDiscount(9900, 0)).toBe(9900);
    expect(applyDiscount(9900, -10)).toBe(9900);
    expect(applyDiscount(9900, Number.NaN)).toBe(9900);
  });

  it('按百分比四舍五入到最小货币单位', () => {
    expect(applyDiscount(9900, 10)).toBe(8910);
    expect(applyDiscount(100, 33)).toBe(67);
    expect(applyDiscount(1, 50)).toBe(1);
  });

  it('封顶 99%，不会把价格算成 0 或负数', () => {
    expect(applyDiscount(9900, 100)).toBe(applyDiscount(9900, MAX_DISCOUNT_PERCENT));
    expect(applyDiscount(9900, 100)).toBe(99);
    expect(applyDiscount(9900, 500)).toBe(99);
    expect(applyDiscount(9900, 100)).toBeGreaterThan(0);
  });

  it('折扣后金额始终不高于原价且非负', () => {
    for (const percent of [0, 1, 25, 50, 99, 100, 999]) {
      const price = applyDiscount(12345, percent);
      expect(price).toBeGreaterThanOrEqual(0);
      expect(price).toBeLessThanOrEqual(12345);
    }
  });
});

describe('betterDiscount', () => {
  it('两条来源取更优而不是相加', () => {
    // 30% + 30% 若叠加是 51% off；正确口径是 30%。
    expect(betterDiscount(30, 30)).toBe(30);
    expect(betterDiscount(10, 25)).toBe(25);
    expect(betterDiscount(25, 10)).toBe(25);
  });

  it('缺失/非法值按 0 处理', () => {
    expect(betterDiscount(null, 0)).toBe(0);
    expect(betterDiscount(undefined, 15)).toBe(15);
    expect(betterDiscount(-5, 0)).toBe(0);
    expect(betterDiscount(Number.NaN, 20)).toBe(20);
  });

  it('两个来源都超限时仍封顶 99%', () => {
    expect(betterDiscount(150, 200)).toBe(MAX_DISCOUNT_PERCENT);
  });
});

describe('effectiveGroupDiscount', () => {
  beforeEach(() => resetContext());

  it('取用户所有权限组里的最大折扣', () => {
    bindContext(ctxWithGroups([
      { id: 'g1', discount: 5 },
      { id: 'g2', discount: 20 },
      { id: 'g3', discount: null },
    ]));
    return expect(effectiveGroupDiscount('user-1')).resolves.toBe(20);
  });

  it('用户没有任何折扣组时为 0', () => {
    bindContext(ctxWithGroups([]));
    return expect(effectiveGroupDiscount('user-1')).resolves.toBe(0);
  });

  it('组折扣本身超限时按封顶值返回', () => {
    bindContext(ctxWithGroups([{ id: 'g1', discount: 100 }]));
    return expect(effectiveGroupDiscount('user-1')).resolves.toBe(MAX_DISCOUNT_PERCENT);
  });
});
