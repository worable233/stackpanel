import { context } from './context';

/**
 * 折扣口径（唯一真值，所有计价路径共用）。
 *
 * 两条折扣来源：
 * 1. **商品折扣** `Product.discount`（% off，0–99）——面向所有买家。
 * 2. **权限组折扣** `PermissionGroup.discount`（% off）——面向该用户所在权限组，
 *    即 V10 的「代理/客户等级折扣」等价物。
 *
 * 规则：**取更优者，不叠加**。叠加会让两个 30% 的折扣变成 51% off，等于凭空
 * 发明一种新的定价策略；V10 的 `client_discount_by_amount` 也是按等级择一。
 *
 * 关键不变量：**展示价与实付价必须用同一套规则**。此前只有 `orders.ts` 应用
 * 折扣，商品页试算 / 购物车 / 续费 / 变配 / 合作方下单都不应用，用户看到原价、
 * 却在付款时被少收（或反之）——同一件商品在两条路径上算出两个价格，属于真实
 * 缺陷而非「功能缺失」。
 */

/** 折扣上限（%）：100 会把商品变成免费，99 是「最多打到 1 折」的硬边界。 */
export const MAX_DISCOUNT_PERCENT = 99;

/** 应用折扣后的单价（minor units）。非正折扣或无折扣时返回原值。 */
export function applyDiscount(unit: number, discountPercent: number): number {
  if (!Number.isFinite(discountPercent) || discountPercent <= 0) return unit;
  const capped = Math.min(discountPercent, MAX_DISCOUNT_PERCENT);
  return Math.round((unit * (100 - capped)) / 100);
}

/** 两条折扣来源取更优（数值更大者）；都缺失时为 0。 */
export function betterDiscount(productDiscount: number | null | undefined, groupDiscount: number): number {
  const product = normalizePercent(productDiscount);
  const group = normalizePercent(groupDiscount);
  return Math.max(product, group);
}

/** 归一到 [0, 99]；非法值（负数/非数）按 0 处理，避免把价格算成负数。 */
function normalizePercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_DISCOUNT_PERCENT);
}

/**
 * 用户所在权限组的最大折扣（%），无折扣返回 0。
 *
 * 取**最大**而不是累加，理由同 {@link betterDiscount}：权限是并集，折扣是择一，
 * 否则给用户多加一个组就能把折扣叠到离谱。
 */
export async function effectiveGroupDiscount(userId: string): Promise<number> {
  const groups = await context().auth.listUserGroups(userId);
  let max = 0;
  for (const group of groups) {
    if (group.discount != null && group.discount > max) max = group.discount;
  }
  return normalizePercent(max);
}

/** 未登录（匿名）时的组折扣：0。 */
export function anonymousGroupDiscount(): number {
  return 0;
}
