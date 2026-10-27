import { z } from 'zod';
import type { CheckoutSelection } from '@stackpanel/sdk';
import { StoreError } from './errors';

export const MAX_MINOR_AMOUNT = 2_000_000_000;

/** 周期 id → 时长（月）；未知周期按 1 个月。 */
export function monthsForCycle(cycleId: string | undefined): number {
  switch (cycleId) {
    case 'yearly':
    case 'annual':
      return 12;
    case 'quarterly':
      return 3;
    case 'halfyearly':
    case 'semiannual':
      return 6;
    default:
      return 1;
  }
}

/** 从 metadata 的 checkoutConfig 读取 cycles（宽松，仅供时长/取价）。 */
export function readCycles(
  metadata: unknown,
): Array<{ id: string; price?: number; renewPrice?: number; months?: number }> | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const config = (metadata as Record<string, unknown>)['checkoutConfig'];
  if (config === null || typeof config !== 'object') return null;
  const cycles = (config as Record<string, unknown>)['cycles'];
  if (!Array.isArray(cycles)) return null;
  return cycles.filter(
    (cycle): cycle is { id: string; price?: number; renewPrice?: number; months?: number } =>
      cycle !== null &&
      typeof cycle === 'object' &&
      typeof (cycle as { id?: unknown }).id === 'string',
  );
}

/** 指定周期的时长（月）：优先显式 `months`，否则按 id 推断。 */
export function cycleMonths(metadata: unknown, cycleId: string | undefined): number | null {
  const cycles = readCycles(metadata);
  if (!cycles || cycles.length === 0) return null;
  const cycle = cycleId ? cycles.find((candidate) => candidate.id === cycleId) : cycles[0];
  if (!cycle) return null;
  if (cycle.months && Number.isInteger(cycle.months) && cycle.months > 0) return cycle.months;
  return monthsForCycle(cycle.id);
}

/** 从 metadata 读取顶层 `billingCycle`（原生云服务器商品用它声明周期）。 */
function readBillingCycle(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)['billingCycle'];
  return typeof value === 'string' && value ? value : null;
}

/**
 * 开通时的初始到期时间：按结账周期（`config.cycle`，缺省取第一个周期）从 `now`
 * 起算。周期来源依次为 `checkoutConfig.cycles`、商品 `metadata.billingCycle`、
 * 结账选择的 `cycle`。商品未配置任何周期（非周期商品/一次性）时返回 null（永久有效）。
 */
export function initialExpiryAt(
  metadata: unknown,
  cycleId: string | undefined,
  now: Date,
): Date | null {
  const months =
    cycleMonths(metadata, cycleId) ??
    (readBillingCycle(metadata) ? monthsForCycle(readBillingCycle(metadata)!) : null) ??
    (cycleId ? monthsForCycle(cycleId) : null);
  if (!months) return null;
  const next = new Date(now.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
}

/** 商品 metadata 里可配置商品的结账配置（checkoutConfig）shape 校验。 */
export const checkoutConfigZod = z.object({
  cycles: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(64),
        price: z.number().int().min(0).max(MAX_MINOR_AMOUNT),
        renewPrice: z.number().int().min(0).max(MAX_MINOR_AMOUNT).optional(),
        // 周期时长（月），供续费推算新到期时间；缺省按 id 推断。
        months: z.number().int().positive().max(120).optional(),
      }),
    )
    .min(1),
  options: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(64),
        type: z.enum(['select', 'quantity']),
        group: z.string().max(64).optional(),
        help: z.string().max(256).optional(),
        unit: z.string().max(16).optional(),
        min: z.number().int().min(0).max(1_000_000).optional(),
        max: z.number().int().min(0).max(1_000_000).optional(),
        step: z.number().int().min(1).max(1_000_000).optional(),
        required: z.boolean().optional(),
        defaultChoice: z.string().max(64).optional(),
        visibleWhen: z
          .object({
            field: z.string().min(1).max(64),
            equals: z.unknown().optional(),
            in: z.array(z.unknown()).optional(),
          })
          .optional(),
        choices: z
          .array(
            z.object({
              id: z.string().min(1).max(64),
              label: z.string().min(1).max(64),
              price: z.number().int().min(0).max(MAX_MINOR_AMOUNT).optional(),
              prices: z
                .record(z.string(), z.number().int().min(0).max(MAX_MINOR_AMOUNT))
                .optional(),
              requires: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
              recurring: z.boolean().optional(),
              qtyMin: z.number().int().min(0).optional(),
              qtyMax: z.number().int().min(0).optional(),
            }),
          )
          .optional(),
      }),
    )
    .default([]),
});

/** 校验并规范化商品 metadata 中的 checkoutConfig（非法则抛错）。 */
export function validateCheckoutConfig(metadata: Record<string, unknown> | null | undefined): void {
  if (!metadata || metadata['checkoutConfig'] === undefined) return;
  const parsed = checkoutConfigZod.safeParse(metadata['checkoutConfig']);
  if (!parsed.success) {
    throw new StoreError(400, '商品结账配置无效');
  }
  metadata['checkoutConfig'] = parsed.data;
}

/** 结账配置选择（来自订单/购物车请求的 JSON 字符串或对象）。 */
export function parseCheckoutSelection(value: unknown): CheckoutSelection | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return normalizeSelection(parsed);
    } catch {
      throw new StoreError(400, '商品配置无效');
    }
  }
  return normalizeSelection(value);
}

function normalizeSelection(value: unknown): CheckoutSelection | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError(400, '商品配置无效');
  }
  const record = value as Record<string, unknown>;
  if (
    record.instanceName !== undefined &&
    (typeof record.instanceName !== 'string' ||
      record.instanceName.trim().length > 64 ||
      /[\u0000-\u001f\u007f]/.test(record.instanceName))
  ) {
    throw new StoreError(400, '商品配置无效');
  }
  const selections: Record<string, string | number> = {};
  if (record.selections !== undefined) {
    if (record.selections === null || typeof record.selections !== 'object') {
      throw new StoreError(400, '商品配置无效');
    }
    for (const [key, val] of Object.entries(record.selections as Record<string, unknown>)) {
      if (typeof val === 'string' || typeof val === 'number') selections[key] = val;
      else throw new StoreError(400, '商品配置无效');
    }
  }
  return {
    ...(typeof record.instanceName === 'string' && record.instanceName.trim()
      ? { instanceName: record.instanceName.trim() }
      : {}),
    ...(typeof record.cycle === 'string' && record.cycle ? { cycle: record.cycle } : {}),
    ...(Object.keys(selections).length ? { selections } : {}),
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
  };
}

/**
 * Stable identity for a cart line's configuration.
 *
 * Two lines are "the same purchase" only when the customer would get the same
 * thing: same cycle and same option→choice mapping. The key must therefore be
 * order-insensitive (object key order carries no meaning) and must ignore
 * `summary`, which is a display string the provider may re-word at any time.
 * `instanceName` is included: two differently-named servers are two servers.
 *
 * Returning a canonical JSON string keeps the comparison allocation-free at the
 * call site and makes a mismatch debuggable in logs.
 */
export function selectionKey(config: CheckoutSelection | null | undefined): string {
  if (!config) return '';
  const selections = Object.keys(config.selections ?? {})
    .sort()
    .map((key) => [key, config.selections?.[key]] as const);
  return JSON.stringify({
    cycle: config.cycle ?? '',
    instanceName: config.instanceName ?? '',
    selections,
  });
}

export const productSchema = z.object({
  name: z.string().trim().min(1).max(191),
  description: z.string().trim().max(191).optional(),
  price: z.number().int().positive().max(MAX_MINOR_AMOUNT),
  // Products may be priced in any **catalog** currency (PLAN-currency §4.2).
  // Free-text 3-letter codes are rejected: the code is validated against the
  // kernel catalog by `assertCurrency` at the API boundary and in the admin UI.
  // The legacy 3-char shape is kept here so the error code stays stable; the
  // actual catalog check happens in `resolveProductCurrency`.
  currency: z.string().trim().min(1).max(8).default('CNY'),
  stock: z.number().int().nonnegative().max(1_000_000).default(0),
  // 成本（分，可空）：关联上游商品时同步上游价格，仅后台可见。
  cost: z.number().int().nonnegative().max(MAX_MINOR_AMOUNT).nullish(),
  // 原价（分，可空）：商品页划线展示。
  originalPrice: z.number().int().nonnegative().max(MAX_MINOR_AMOUNT).nullish(),
  // 商品折扣（%，可空 0-99）：下单时应用，与权限组折扣取更优。
  discount: z.number().int().min(0).max(99).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  // 履约模型：分类 + 交付类型 + 提供方关联。
  categoryId: z.string().min(1).max(191).nullish(),
  fulfillmentType: z.string().min(1).max(64).default('instant'),
  providerId: z.string().min(1).max(64).nullish(),
  providerProductId: z.string().min(1).max(191).nullish(),
  // Transient selector value from the admin form. The store persists the verified
  // instance id only in metadata.upstream via the registered source.
  upstreamSourceRef: z.string().min(1).max(191).nullish(),
  /**
   * Listing state. Only `ACTIVE` is sellable; anything else hides the product
   * from the public catalogue, the account catalogue and the cart.
   *
   * Without this field a product could never be taken off sale: `status` was
   * written on create and then unreachable, so an operator whose upstream
   * provider disappeared had no way to stop customers buying an undeliverable
   * product — the only escape was deleting the row (which also destroys order
   * history references).
   */
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

// 注意：zod 的 .partial() 不会中和 .default()，直接 partial 会让局部更新
// 把带默认值的字段（currency/stock/fulfillmentType）重置为默认值。
// 这里先把它们显式改成可选，再做 partial，保证只更新传入的字段。
const productUpdateBase = productSchema.extend({
  currency: z.string().trim().min(1).max(8).optional(),
  stock: z.number().int().nonnegative().max(1_000_000).optional(),
  fulfillmentType: z.string().min(1).max(64).optional(),
});

export const productUpdateSchema = productUpdateBase
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要一个更新字段' });

export const createOrderSchema = z.object({
  productId: z.string().min(1).max(191),
  quantity: z.number().int().positive().max(100).default(1),
  paymentMode: z.enum(['wallet', 'external']).default('wallet'),
  channelCode: z.string().min(1).max(64).default('MALL_PC'),
  providerId: z.string().min(1).max(64).optional(),
  paymentMethod: z.string().min(1).max(64).optional(),
  methodId: z.string().min(1).max(191).optional(),
  // 可配置商品：周期 + 配置项选择（前端以 JSON 字符串提交）。
  config: z.string().optional(),
});

export const checkoutSchema = z.object({
  cartItemIds: z.array(z.string().min(1).max(191)).min(1).max(50),
  paymentMode: z.enum(['wallet', 'external']).default('wallet'),
  channelCode: z.string().min(1).max(64).default('MALL_PC'),
  providerId: z.string().min(1).max(64).optional(),
  paymentMethod: z.string().min(1).max(64).optional(),
  methodId: z.string().min(1).max(191).optional(),
});

/** 续费下单入参。`months` 显式指定时长；否则按 `cycle` 推断（缺省 1 个月）。 */
export const renewOrderSchema = z.object({
  serviceId: z.string().min(1).max(191).optional(),
  paymentMode: z.enum(['wallet', 'external']).default('wallet'),
  channelCode: z.string().min(1).max(64).default('MALL_PC'),
  cycle: z.string().min(1).max(64).optional(),
  months: z.number().int().positive().max(120).optional(),
  providerId: z.string().min(1).max(64).optional(),
  paymentMethod: z.string().min(1).max(64).optional(),
  methodId: z.string().min(1).max(191).optional(),
});

/**
 * 升配/降配/换商品下单入参。
 * - `config`：目标配置选择（JSON 字符串），与下单同形。
 * - `targetProductId`：换商品时的目标商品 id；与 `config` 二选一（可同时给）。
 */
export const changeServiceSchema = z.object({
  serviceId: z.string().min(1).max(191).optional(),
  config: z.string().optional(),
  targetProductId: z.string().min(1).max(191).optional(),
  paymentMode: z.enum(['wallet', 'external']).default('wallet'),
  channelCode: z.string().min(1).max(64).default('MALL_PC'),
  providerId: z.string().min(1).max(64).optional(),
  paymentMethod: z.string().min(1).max(64).optional(),
  methodId: z.string().min(1).max(191).optional(),
});

/** 变更试算入参。 */
export const changeQuoteSchema = z.object({
  config: z.string().optional(),
  targetProductId: z.string().min(1).max(191).optional(),
});

/** 产品转移入参（管理端）。 */
export const transferServiceSchema = z.object({
  targetUserId: z.string().min(1).max(191),
});

/** 退款入参：`amount` 为最小货币单位；缺省全额退款。 */
export const refundOrderSchema = z.object({
  amount: z.number().int().positive().max(MAX_MINOR_AMOUNT).optional(),
  reason: z.string().trim().max(191).optional(),
});

export const addToCartSchema = z.object({
  productId: z.string().min(1).max(191),
  quantity: z.number().int().positive().max(100).default(1),
  // 可配置商品：周期 + 配置项选择（前端以 JSON 字符串提交）。
  config: z.string().optional(),
});

export const updateCartQuantitySchema = z.object({
  quantity: z.number().int().positive().max(100),
});

export const idSchema = z.object({ id: z.string().min(1).max(191) });

export function parsePagination(query: Record<string, unknown>): {
  page: number;
  pageSize: number;
} {
  const parsed = z
    .object({
      page: z.coerce.number().int().positive().default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    })
    .safeParse(query);
  return parsed.success ? parsed.data : { page: 1, pageSize: 20 };
}

export function orderOptions(
  channelCode: string | undefined,
  methodId: string | undefined,
  providerId: string | undefined,
  paymentMethod: string | undefined,
): { channelCode?: string; methodId?: string; providerId?: string; paymentMethod?: string } {
  const options: {
    channelCode?: string;
    methodId?: string;
    providerId?: string;
    paymentMethod?: string;
  } = {};
  if (channelCode) options.channelCode = channelCode;
  if (methodId) options.methodId = methodId;
  if (providerId && paymentMethod) {
    options.providerId = providerId;
    options.paymentMethod = paymentMethod;
  }
  return options;
}
