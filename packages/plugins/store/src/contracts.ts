/**
 * 公开 / 可购买商品 DTO（PLAN-storefront-display-account-commerce §3、§4.3）。
 *
 * 公开展厅与账户商城是两个不同的读取面，字段白名单必须显式且最小：
 * - 公开面（`PublicProduct`）只暴露顾客可见字段，绝不含成本价、上游 provider
 *   标识、履约密钥或管理 metadata。
 * - 账户商城面（`PurchasableProduct`）在此基础上追加「是否可购买」，供登录用户
 *   配置与下单；仍不含成本价与上游内部标识。
 *
 * 两处都不得直接复用管理端商品 schema（`StoreProductSummary` / admin 接口）。
 */
import { z } from 'zod';
import type { ProductRecord } from './repository.js';

/**
 * `product.metadata` 中可公开的展示键白名单；其余键一律不下发。
 *
 * 上游同步写入的 `metadata.upstream`（含 `sourceRef` / 上游商品 id / 源价）是
 * 典型的内部数据，必须被挡在白名单之外，避免经公开接口泄露。
 */
export const PUBLIC_METADATA_KEYS = [
  'specs',
  'checkoutConfig',
  'billingCycle',
  'icon',
  'image',
  'network',
  'region',
] as const;

/** 从商品 metadata 提取公开子集；无任何公开键时返回 null。 */
export function publicMetadata(metadata: unknown): Record<string, unknown> | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const key of PUBLIC_METADATA_KEYS) {
    if (record[key] !== undefined) keep[key] = record[key];
  }
  return Object.keys(keep).length > 0 ? keep : null;
}

/** 公开展厅商品 DTO：顾客可见字段白名单。 */
export interface PublicProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number;
  status: string;
  categoryId: string | null;
  fulfillmentType: string;
  /** 划线展示用原价；非敏感营销字段。 */
  originalPrice: number | null;
  /** 商品级折扣（%）；下单时与用户组折扣取更优，不是用户组折扣本身。 */
  discount: number | null;
  metadata: Record<string, unknown> | null;
}

/** 公开展厅条目（分类插件可挂接的目录项形态）。 */
export interface PublicCatalogEntry {
  product: PublicProduct;
}

/** 账户商城可购买商品 DTO：公开字段 + 可购买性判定。 */
export interface PurchasableProduct extends PublicProduct {
  purchasable: boolean;
  unavailableReason: 'inactive' | 'out_of_stock' | 'forbidden' | null;
}

export function toPublicProduct(record: ProductRecord): PublicProduct {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    price: record.price,
    currency: record.currency,
    stock: record.stock,
    status: record.status,
    categoryId: record.categoryId,
    fulfillmentType: record.fulfillmentType,
    originalPrice: record.originalPrice,
    discount: record.discount,
    metadata: publicMetadata(record.metadata),
  };
}

export function toPublicCatalogEntry(record: ProductRecord): PublicCatalogEntry {
  return { product: toPublicProduct(record) };
}

/**
 * 账户商城的可购买视图。`canBuy` 为调用者是否持有 `store.buy`；服务端根据
 * 商品状态、库存与购买资格给出 `purchasable`，前端不得自行推断。
 */
export function toPurchasableProduct(record: ProductRecord, canBuy: boolean): PurchasableProduct {
  const active = record.status === 'ACTIVE';
  const inStock = record.stock > 0;
  const purchasable = active && inStock && canBuy;
  const unavailableReason: PurchasableProduct['unavailableReason'] = !active
    ? 'inactive'
    : !inStock
      ? 'out_of_stock'
      : !canBuy
        ? 'forbidden'
        : null;
  return { ...toPublicProduct(record), purchasable, unavailableReason };
}

export const publicProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.number(),
  currency: z.string(),
  stock: z.number(),
  status: z.string(),
  categoryId: z.string().nullable(),
  fulfillmentType: z.string(),
  originalPrice: z.number().nullable(),
  discount: z.number().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

export const publicCatalogEntrySchema = z.object({ product: publicProductSchema });

export const purchasableProductSchema = publicProductSchema.extend({
  purchasable: z.boolean(),
  unavailableReason: z.enum(['inactive', 'out_of_stock', 'forbidden']).nullable(),
});
