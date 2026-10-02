import { z } from 'zod';
import type { CheckoutSelection } from '@stackpanel/sdk';
import { StoreError } from './errors';

export const MAX_MINOR_AMOUNT = 2_000_000_000;

/** 商品 metadata 里可配置商品的结账配置（checkoutConfig）shape 校验。 */
export const checkoutConfigZod = z.object({
  cycles: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(64),
        price: z.number().int().min(0).max(MAX_MINOR_AMOUNT),
        renewPrice: z.number().int().min(0).max(MAX_MINOR_AMOUNT).optional(),
      }),
    )
    .min(1),
  options: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(64),
        type: z.enum(['select', 'quantity']),
        unit: z.string().max(16).optional(),
        min: z.number().int().min(0).max(1_000_000).optional(),
        max: z.number().int().min(0).max(1_000_000).optional(),
        step: z.number().int().min(1).max(1_000_000).optional(),
        required: z.boolean().optional(),
        choices: z
          .array(
            z.object({
              id: z.string().min(1).max(64),
              label: z.string().min(1).max(64),
              price: z.number().int().min(0).max(MAX_MINOR_AMOUNT).optional(),
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
export function parseCheckoutSelection(
  value: unknown,
): CheckoutSelection | undefined {
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
    ...(typeof record.cycle === 'string' && record.cycle ? { cycle: record.cycle } : {}),
    ...(Object.keys(selections).length ? { selections } : {}),
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
  };
}

export const productSchema = z.object({
  name: z.string().trim().min(1).max(191),
  description: z.string().trim().max(191).optional(),
  price: z.number().int().positive().max(MAX_MINOR_AMOUNT),
  // Products may be priced in any ISO currency. At checkout the order total is
  // converted to the settlement currency via the kernel FX service (frozen
  // snapshot), so non-CNY products remain payable.
  currency: z.string().length(3).default('CNY'),
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
});

// 注意：zod 的 .partial() 不会中和 .default()，直接 partial 会让局部更新
// 把带默认值的字段（currency/stock/fulfillmentType）重置为默认值。
// 这里先把它们显式改成可选，再做 partial，保证只更新传入的字段。
const productUpdateBase = productSchema.extend({
  currency: z.string().length(3).optional(),
  stock: z.number().int().nonnegative().max(1_000_000).optional(),
  fulfillmentType: z.string().min(1).max(64).optional(),
});

export const productUpdateSchema = productUpdateBase.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: '至少需要一个更新字段' },
);

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

export function parsePagination(query: Record<string, unknown>): { page: number; pageSize: number } {
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
  const options: { channelCode?: string; methodId?: string; providerId?: string; paymentMethod?: string } =
    {};
  if (channelCode) options.channelCode = channelCode;
  if (methodId) options.methodId = methodId;
  if (providerId && paymentMethod) {
    options.providerId = providerId;
    options.paymentMethod = paymentMethod;
  }
  return options;
}