import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '@stackpanel/sdk';
const mocks = vi.hoisted(() => ({ find: vi.fn(), payments: vi.fn() }));
vi.mock('./repository', async (original) => ({
  ...(await original<typeof import('./repository')>()),
  findOrderForUser: mocks.find,
}));
vi.mock('./context', async (original) => ({
  ...(await original<typeof import('./context')>()),
  context: () => ({ payments: { listByOrderIds: mocks.payments } }),
}));
import { getMyOrder } from './orders';
const req = (user = true) =>
  ({
    params: { id: 'order' },
    query: {},
    headers: {},
    body: undefined,
    ...(user ? { user: { id: 'buyer', role: 'USER' } } : {}),
  }) as HttpRequest;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.payments.mockResolvedValue([
    { orderId: 'order', paymentUrl: 'https://pay.example/session' },
  ]);
});
describe('owner-scoped cart payment result', () => {
  it('requires authentication', async () => {
    await expect(getMyOrder(req(false))).rejects.toMatchObject({ status: 401 });
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it('does not reveal another user order or payment URL', async () => {
    mocks.find.mockResolvedValue(null);
    await expect(getMyOrder(req())).rejects.toMatchObject({ status: 404 });
    expect(mocks.find).toHaveBeenCalledWith('order', 'buyer');
    expect(mocks.payments).not.toHaveBeenCalled();
  });
  it.each(['PENDING', 'PAID', 'CANCELLED'])(
    'returns authoritative %s and only exposes resumable pending payment',
    async (status) => {
      mocks.find.mockResolvedValue({
        id: 'order',
        userId: 'buyer',
        status,
        total: 137,
        currency: 'CNY',
        settlementTotal: 137,
        settlementCurrency: 'CNY',
        items: [{ password: 'must-not-expose' }],
      });
      expect(await getMyOrder(req())).toEqual({
        order: {
          id: 'order',
          status,
          total: 137,
          currency: 'CNY',
          settlementTotal: 137,
          settlementCurrency: 'CNY',
          paymentUrl: status === 'PENDING' ? 'https://pay.example/session' : null,
        },
      });
    },
  );
});
