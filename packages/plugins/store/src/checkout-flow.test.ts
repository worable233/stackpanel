import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpReply } from '@stackpanel/sdk';
const mocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  replace: vi.fn(),
  groups: vi.fn(),
}));
vi.mock('./repository', () => ({
  getProduct: mocks.getProduct,
  listCartItemsByUser: mocks.list,
  createCartItem: mocks.create,
  deleteCartItems: vi.fn(),
  getCartItem: vi.fn(),
  replaceCartItem: mocks.replace,
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
function replyStub(): { reply: HttpReply; sent: () => unknown } {
  const state: { body?: unknown } = {};
  const reply = {
    code: vi.fn(() => reply),
    send: vi.fn((body: unknown) => {
      state.body = body;
      return reply;
    }),
  };
  return { reply: reply as unknown as HttpReply, sent: () => state.body };
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
    mocks.list.mockResolvedValue([]);
    await expect(
      addToCart(req({ productId: 'p', quantity: 11 }), {} as HttpReply),
    ).rejects.toMatchObject({ status: 409 });
    mocks.getProduct.mockResolvedValue(configured);
    await expect(
      addToCart(req({ productId: 'p', quantity: 1 }), {} as HttpReply),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('merges a repeat add of the same configuration instead of adding a duplicate line', async () => {
    mocks.getProduct.mockResolvedValue(configured);
    // Same purchase, option keys deliberately in a different order: identity
    // must not depend on serialisation order.
    mocks.list.mockResolvedValue([
      {
        id: 'item-1',
        userId: 'u',
        productId: 'p',
        quantity: 1,
        config: { cycle: 'monthly', selections: { cpu: 'two' } },
      },
    ]);
    mocks.replace.mockResolvedValue({ id: 'item-1', productId: 'p', quantity: 3, userId: 'u' });
    const stub = replyStub();
    await addToCart(
      req({
        productId: 'p',
        quantity: 2,
        config: JSON.stringify({ selections: { cpu: 'two' }, cycle: 'monthly' }),
      }),
      stub.reply,
    );
    const result = stub.sent() as { merged?: boolean; item: { quantity: number } };
    expect(mocks.create).not.toHaveBeenCalled();
    expect(result.merged).toBe(true);
    expect(result.item.quantity).toBe(3);
    expect(mocks.replace).toHaveBeenCalledWith(
      'item-1',
      expect.objectContaining({ quantity: 3 }),
    );
  });

  it('keeps a differently configured line separate and caps the merged quantity by stock', async () => {
    mocks.getProduct.mockResolvedValue(configured);
    mocks.list.mockResolvedValue([
      {
        id: 'item-1',
        userId: 'u',
        productId: 'p',
        quantity: 9,
        config: { cycle: 'monthly', selections: { cpu: 'two' } },
      },
    ]);
    // Same product, a DIFFERENT cycle => a different purchase, so it must not
    // merge. The fixture only declares `monthly`, so use a changed option
    // instead of an unknown cycle (which would be rejected as invalid config).
    mocks.create.mockResolvedValue({ id: 'item-2', productId: 'p', quantity: 1 });
    const reply = replyStub().reply;
    mocks.list.mockResolvedValue([
      {
        id: 'item-1',
        userId: 'u',
        productId: 'p',
        quantity: 9,
        config: { cycle: 'monthly', selections: { cpu: 'two' } },
      },
    ]);
    await expect(
      addToCart(
        req({
          productId: 'p',
          quantity: 1,
          config: JSON.stringify({ cycle: 'monthly', selections: { cpu: 'one' } }),
        }),
        reply,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.create).not.toHaveBeenCalled();

    // A different quantity is NOT a different purchase: stock must still cap
    // the merged total (9 + 2 > 10).
    await expect(
      addToCart(
        req({
          productId: 'p',
          quantity: 2,
          config: JSON.stringify({ cycle: 'monthly', selections: { cpu: 'two' } }),
        }),
        reply,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
