import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), stock: vi.fn(), source: vi.fn() }));
vi.mock('./repository', () => ({ getProduct: mocks.get, setProductStock: mocks.stock }));
vi.mock('./context', () => ({
  context: () => ({
    auth: { hasPermission: async () => true },
    getExtensions: () => [{ id: 'zjmf', get: mocks.source }],
  }),
}));
import { getPurchasableProduct } from './products';
describe('checkout inventory refresh', () => {
  it('replaces a stale zero with the real upstream stock, without inventing ten', async () => {
    mocks.get.mockResolvedValue({
      id: 'p',
      name: 'Server',
      price: 100,
      currency: 'CNY',
      status: 'ACTIVE',
      stock: 0,
      providerId: 'zjmf',
      providerProductId: '4661',
      metadata: { upstream: { sourceRef: 'source' } },
    });
    mocks.source.mockResolvedValue({ stock: 8 });
    const result = (await getPurchasableProduct({
      params: { id: 'p' },
      user: { id: 'u' },
    } as never)) as { product: { stock: number; purchasable: boolean } };
    expect(result.product.stock).toBe(8);
    expect(result.product.purchasable).toBe(true);
    expect(mocks.stock).toHaveBeenCalledWith('p', 8);
    mocks.source.mockRejectedValueOnce(new Error('unavailable'));
    const failed = (await getPurchasableProduct({
      params: { id: 'p' },
      user: { id: 'u' },
    } as never)) as { product: { stock: number } };
    expect(failed.product.stock).toBe(0);
  });
});
