import { describe, expect, it } from 'vitest';
import type { ProductRecord } from './repository';
import {
  PUBLIC_METADATA_KEYS,
  publicMetadata,
  toPublicProduct,
  toPurchasableProduct,
} from './contracts';

function product(overrides: Partial<ProductRecord> = {}): ProductRecord {
  return {
    id: 'prod_1',
    name: 'VPS',
    description: '1 vCPU',
    price: 9900,
    currency: 'CNY',
    cost: 4000,
    originalPrice: 12000,
    discount: 10,
    stock: 3,
    status: 'ACTIVE',
    metadata: {
      specs: { CPU: '1 core' },
      checkoutConfig: { cycles: [], options: [] },
      // 上游同步内部数据：绝不允许出现在公开 DTO。
      upstream: { sourceRef: 'zjmf:12', productId: 'up_9', sourcePrice: 5000 },
      internalNotes: 'admin only',
    },
    categoryId: 'cat_1',
    fulfillmentType: 'instant',
    providerId: 'zjmf',
    providerProductId: 'up_9',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('publicMetadata', () => {
  it('keeps only the public whitelist and drops upstream/internal keys', () => {
    const result = publicMetadata(product().metadata);
    expect(result).toEqual({
      specs: { CPU: '1 core' },
      checkoutConfig: { cycles: [], options: [] },
    });
    expect(result).not.toHaveProperty('upstream');
    expect(result).not.toHaveProperty('internalNotes');
  });

  it('returns null when no public key is present', () => {
    expect(publicMetadata({ internalNotes: 'x' })).toBeNull();
    expect(publicMetadata(null)).toBeNull();
    expect(publicMetadata([])).toBeNull();
  });

  it('exposes exactly the declared whitelist', () => {
    expect([...PUBLIC_METADATA_KEYS]).toEqual([
      'specs',
      'checkoutConfig',
      'billingCycle',
      'icon',
      'image',
      'network',
      'region',
    ]);
  });
});

describe('toPublicProduct', () => {
  it('never leaks cost, discount, provider ids or upstream metadata', () => {
    const dto = toPublicProduct(product()) as unknown as Record<string, unknown>;
    expect(dto).not.toHaveProperty('cost');
    expect(dto).not.toHaveProperty('providerId');
    expect(dto).not.toHaveProperty('providerProductId');
    expect(dto.metadata).not.toHaveProperty('upstream');
  });

  it('keeps customer-facing fields', () => {
    const dto = toPublicProduct(product());
    expect(dto.id).toBe('prod_1');
    expect(dto.price).toBe(9900);
    expect(dto.originalPrice).toBe(12000);
    expect(dto.stock).toBe(3);
  });
});

describe('toPurchasableProduct', () => {
  it('marks an active, in-stock product purchasable with store.buy', () => {
    const dto = toPurchasableProduct(product(), true);
    expect(dto.purchasable).toBe(true);
    expect(dto.unavailableReason).toBeNull();
  });

  it('reports forbidden without store.buy', () => {
    const dto = toPurchasableProduct(product(), false);
    expect(dto.purchasable).toBe(false);
    expect(dto.unavailableReason).toBe('forbidden');
  });

  it('reports inactive when the product is not ACTIVE', () => {
    const dto = toPurchasableProduct(product({ status: 'OFF' }), true);
    expect(dto.purchasable).toBe(false);
    expect(dto.unavailableReason).toBe('inactive');
  });

  it('reports out_of_stock when stock is empty', () => {
    const dto = toPurchasableProduct(product({ stock: 0 }), true);
    expect(dto.purchasable).toBe(false);
    expect(dto.unavailableReason).toBe('out_of_stock');
  });

  it('still hides sensitive fields in the purchasable view', () => {
    const dto = toPurchasableProduct(product(), true) as unknown as Record<string, unknown>;
    expect(dto).not.toHaveProperty('cost');
    expect(dto).not.toHaveProperty('providerId');
  });
});
