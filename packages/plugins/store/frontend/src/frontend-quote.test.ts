import { describe, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('./auto-submit.js', () => ({ AutoSubmitForm: () => null, CartCheckout: () => null }));
import frontend from './index';

describe('storefront authoritative quote failure recovery', () => {
  it('quotes catalog products using checkout authority and exposes original totals', async () => {
    const post = vi.fn().mockResolvedValue({ productId: 'cloud', price: 137, originalTotal: 6840, total: 137, quantity: 1, currency: 'CNY' });
    const get = vi.fn().mockResolvedValue({ products: [{ id: 'cloud', price: 5500, metadata: null, originalPrice: null }], total: 1 });
    const handler = frontend.finders!['store.accountProducts']!.handler;
    const result = await handler({}, { api: { get, post } } as unknown as Parameters<typeof handler>[1]);
    expect(result).toMatchObject({ products: [{ price: 137, originalPrice: 6840, quoteAvailable: true }] });
    expect(post.mock.calls[0]?.[0]).toBe('/store/products/cloud/price');
  });
  it('marks a failed catalog quote unavailable rather than representing a catalog amount as a live quote', async () => {
    const post = vi.fn().mockRejectedValue(new Error('timeout'));
    const get = vi.fn().mockResolvedValue({ products: [{ id: 'cloud', price: 5500, metadata: null }], total: 1 });
    const handler = frontend.finders!['store.accountProducts']!.handler;
    const result = await handler({}, { api: { get, post } } as unknown as Parameters<typeof handler>[1]);
    expect(result).toMatchObject({ products: [{ quoteAvailable: false }] });
  });
  it('does not substitute catalog price after a failed quote and retries the real configuration', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new Error('upstream timeout'))
      .mockResolvedValueOnce({
        price: 137,
        total: 274,
        quantity: 2,
        currency: 'CNY',
        renewPrice: 137,
      });
    const get = vi.fn().mockResolvedValue({
      product: {
        id: 'real-product',
        name: 'Real product',
        price: 7200,
        currency: 'CNY',
        description: null,
        stock: 10,
        status: 'ACTIVE',
        purchasable: true,
        metadata: {
          checkoutConfig: {
            cycles: [{ id: 'monthly', label: 'Monthly', price: 7200 }],
            options: [
              {
                id: 'cpu',
                label: 'CPU',
                type: 'select',
                choices: [{ id: 'provider-four', label: '4 cores' }],
              },
            ],
          },
        },
      },
    });
    const handler = frontend.finders!['store.pricePreview']!.handler;
    const input = {
      id: 'real-product',
      $query: { quantity: '2', cycle: 'monthly', cfg_cpu: 'provider-four', instanceName: 'production' },
    };
    const context = { api: { get, post } } as unknown as Parameters<typeof handler>[1];
    expect(await handler(input, context)).toBeNull();
    expect(await handler(input, context)).toMatchObject({ price: 137, total: 274 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[1]).toEqual({
      quantity: '2',
      config: JSON.stringify({ instanceName: 'production', cycle: 'monthly', selections: { cpu: 'provider-four' } }),
    });
  });
});
