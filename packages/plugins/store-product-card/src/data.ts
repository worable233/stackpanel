import { defineModel } from '@stackpanel/sdk';
import { z } from 'zod';

/** 卡密池模型：每行一张卡密的发放状态。存储/DDL/索引由 Extension 引擎承载。 */
export const CARD_CODE_KIND = 'store-product-card/card-code';

export const cardCodeModel = defineModel({
  kind: CARD_CODE_KIND,
  label: '发卡卡密',
  schema: z.object({
    productId: z.string(),
    code: z.string(),
    status: z.enum(['AVAILABLE', 'USED']).default('AVAILABLE'),
    orderId: z.string().nullable().optional(),
    userId: z.string().nullable().optional(),
    consumedAt: z.string().nullable().optional(),
  }),
  indexes: [
    { fields: ['productId'], types: { productId: 'string' } },
    { fields: ['status'], types: { status: 'string' } },
  ],
});

/** 卡密载荷（与 {@link cardCodeModel} 的 zod schema 对齐）。 */
export interface CardCodeData {
  productId: string;
  code: string;
  status: 'AVAILABLE' | 'USED';
  orderId?: string | null;
  userId?: string | null;
  consumedAt?: string | null;
}

