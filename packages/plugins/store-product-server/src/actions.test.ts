import { describe, expect, it } from 'vitest';
import type { PluginContext, ProductTypeProvider } from '@stackpanel/sdk';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import storeProductServerPlugin from './index.js';

function captureProductType(): ProductTypeProvider {
  let captured: ProductTypeProvider | null = null;
  const ctx = {
    registerExtension: (pointId: string, implementation: unknown) => {
      if (pointId === EXTENSION_POINTS.productType) captured = implementation as ProductTypeProvider;
      return () => {};
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as PluginContext;
  storeProductServerPlugin.onActivate?.(ctx);
  if (!captured) throw new Error('productType not registered');
  return captured;
}

describe('store-product-server production boundary', () => {
  it('does not publish fabricated regions, images, prices, or operations', () => {
    const type = captureProductType();
    expect(type.configFields).toEqual([]);
    expect(type.getDetail).toBeUndefined();
    expect(type.executeAction).toBeUndefined();
    expect(type.calculateCheckoutPrice).toBeUndefined();
  });

  it('fails closed for a legacy cloud-server product without a provider', async () => {
    await expect(captureProductType().provision({} as never)).rejects.toMatchObject({
      code: 'store.cloud_server.provider_required',
      status: 409,
    });
  });
});
