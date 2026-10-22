import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpReply } from '@stackpanel/sdk';
const mocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  groups: vi.fn(),
}));
vi.mock('./repository', () => ({
  getProduct: mocks.getProduct,
  listCartItemsByUser: mocks.list,
  createCartItem: mocks.create,
  deleteCartItems: vi.fn(),
  getCartItem: vi.fn(),
  replaceCartItem: vi.fn(),
}));
vi.mock('./fulfillment', () => ({ providerForProduct: () => null }));
vi.mock('./context', () => ({
  context: () => ({
    auth: { listUserGroups: mocks.groups },
    fx: {
      quoteToSettlement: async (_: string, amount: number) => ({
        toCurrency: 'CNY',
        settlementAmount: amount,
        rate: 1,
      }),
    },
  }),
}));
import { calculateProductPrice, resolveCheckoutPrice } from './pricing';
import { addToCart, listCart } from './cart';
const product = {
  id: 'p',
  name: 'Server',
  price: 1000,
  currency: 'CNY',
  discount: 10,
  metadata: null,
  stock: 10,
  status: 'ACTIVE',
  providerId: null,
  providerProductId: null,
  fulfillmentType: 'instant',
  createdAt: new Date(),
};
const configured = {
  ...product,
  metadata: {
    checkoutConfig: {
      cycles: [{ id: 'monthly', label: 'Monthly', price: 2000 }],
      options: [
        {
          id: 'cpu',
          label: 'CPU',
          type: 'select',
          required: true,
          choices: [{ id: 'two', label: '2 CPU', price: 500 }],
        },
      ],
    },
  },
};
function req(body: unknown): HttpRequest {
  return {
    params: { id: 'p' },
    body,
    user: { id: 'u', role: 'USER' },
    query: {},
    headers: {},
  } as HttpRequest;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProduct.mockResolvedValue(product);
  mocks.groups.mockResolvedValue([{ discount: 20 }]);
});
describe('account purchase pricing and cart', () => {
  it('applies the buyer discount to renewal prices as well as the initial quote', async () => {
    mocks.getProduct.mockResolvedValue(configured);
    const result = await calculateProductPrice(
      req({
        quantity: '2',
        config: JSON.stringify({ cycle: 'monthly', selections: { cpu: 'two' } }),
      }),
    );
    expect(result).toMatchObject({ price: 2000, total: 4000, renewPrice: 2000 });
  });
  it('prices string quantities and applies the same best discount as orders', async () => {
    const result = await calculateProductPrice(req({ quantity: '3' }));
    expect(result).toMatchObject({ price: 800, quantity: 3, total: 2400 });
  });
  it.each([0, -1, 101, 1.5, 'bad'])('rejects invalid quantity %s', async (quantity) => {
    await expect(calculateProductPrice(req({ quantity }))).rejects.toMatchObject({ status: 400 });
  });
  it('requires configuration and prices selected options rather than base price', async () => {
    await expect(resolveCheckoutPrice(configured, 1, undefined)).rejects.toMatchObject({
      code: 'store.checkout.config_invalid',
    });
    await expect(
      resolveCheckoutPrice(configured, 1, { cycle: 'monthly', selections: { cpu: 'two' } }),
    ).resolves.toMatchObject({ unit: 2500 });
    await expect(
      resolveCheckoutPrice(configured, 1, { cycle: 'monthly', selections: { cpu: 'unknown' } }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('keeps unavailable and deleted cart rows removable without hiding healthy rows', async () => {
    mocks.list.mockResolvedValue([
      { id: 'a', productId: 'p', quantity: 2 },
      { id: 'b', productId: 'broken', quantity: 1 },
      { id: 'c', productId: 'deleted', quantity: 1 },
    ]);
    mocks.getProduct.mockImplementation(async (id) =>
      id === 'deleted' ? null : id === 'broken' ? configured : product,
    );
    const result = (await listCart(req({}))) as {
      items: Array<{ total: number; unavailableReason?: string }>;
    };
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({ total: 1600 });
    expect(result.items[1]?.unavailableReason).toBeTruthy();
    expect(result.items[2]?.unavailableReason).toBeTruthy();
  });
  it('rejects excess stock and missing configuration before saving a cart item', async () => {
    await expect(
      addToCart(req({ productId: 'p', quantity: 11 }), {} as HttpReply),
    ).rejects.toMatchObject({ status: 409 });
    mocks.getProduct.mockResolvedValue(configured);
    await expect(
      addToCart(req({ productId: 'p', quantity: 1 }), {} as HttpReply),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
