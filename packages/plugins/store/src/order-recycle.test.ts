import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '@stackpanel/sdk';

const mocks = vi.hoisted(() => ({
  findOrderForUser: vi.fn(),
  getOrder: vi.fn(),
  setOrderDeletedAt: vi.fn(),
  listRecycledOrdersBefore: vi.fn(),
  deleteOrderInstance: vi.fn(),
  audit: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./repository', async (original) => ({
  ...(await original<typeof import('./repository')>()),
  findOrderForUser: mocks.findOrderForUser,
  getOrder: mocks.getOrder,
  setOrderDeletedAt: mocks.setOrderDeletedAt,
  listRecycledOrdersBefore: mocks.listRecycledOrdersBefore,
  deleteOrderInstance: mocks.deleteOrderInstance,
}));
vi.mock('./context', async (original) => ({
  ...(await original<typeof import('./context')>()),
  logger: () => ({ warn: mocks.warn, info: vi.fn(), error: vi.fn() }),
  context: () => ({ auth: { audit: mocks.audit } }),
}));

import { purgeRecycledOrders, RECYCLE_RETENTION_MS } from './recycle';
import { recycleMyOrder, restoreRecycledOrder } from './orders';

const req = (params: Record<string, string> = { id: 'order' }, user = true) =>
  ({
    params,
    query: {},
    headers: {},
    body: undefined,
    ip: '10.0.0.1',
    ...(user ? { user: { id: 'buyer', role: 'USER' } } : {}),
  }) as HttpRequest;

const order = (overrides: Record<string, unknown> = {}) => ({
  id: 'order',
  userId: 'buyer',
  items: { items: [{ productId: 'p1', quantity: 1 }] },
  total: 9900,
  currency: 'CNY',
  status: 'CANCELLED',
  channelCode: null,
  settlementCurrency: 'CNY',
  settlementTotal: 9900,
  fxRate: null,
  deletedAt: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setOrderDeletedAt.mockResolvedValue(true);
});

describe('order recycle bin (unpaid orders)', () => {
  it('requires authentication and never reads another user order', async () => {
    await expect(recycleMyOrder(req({ id: 'order' }, false))).rejects.toMatchObject({
      status: 401,
    });
    expect(mocks.findOrderForUser).not.toHaveBeenCalled();
  });

  it('is owner scoped: a foreign order is simply not found', async () => {
    mocks.findOrderForUser.mockResolvedValue(null);
    await expect(recycleMyOrder(req())).rejects.toMatchObject({ status: 404 });
    expect(mocks.findOrderForUser).toHaveBeenCalledWith('order', 'buyer');
    expect(mocks.setOrderDeletedAt).not.toHaveBeenCalled();
  });

  it.each(['PENDING', 'CANCELLING', 'PAID'])(
    'refuses to recycle a %s order',
    async (status) => {
      mocks.findOrderForUser.mockResolvedValue(order({ status }));
      await expect(recycleMyOrder(req())).rejects.toMatchObject({ status: 409 });
      // 关键：仍在支付中或已支付的订单不得消失 —— 否则一笔还能成功的支付
      // 会从用户视野里被「删掉」。
      expect(mocks.setOrderDeletedAt).not.toHaveBeenCalled();
    },
  );

  it('is idempotent-hostile: an already recycled order is refused', async () => {
    mocks.findOrderForUser.mockResolvedValue(order({ deletedAt: '2026-01-01T00:00:00.000Z' }));
    await expect(recycleMyOrder(req())).rejects.toMatchObject({ status: 409 });
    expect(mocks.setOrderDeletedAt).not.toHaveBeenCalled();
  });

  it('stamps deletedAt instead of deleting and records the audit', async () => {
    mocks.findOrderForUser.mockResolvedValue(order());
    const result = await recycleMyOrder(req());
    expect(result).toEqual({ recycled: true, orderId: 'order' });
    const [, deletedAt] = mocks.setOrderDeletedAt.mock.calls[0] as [string, string];
    expect(Number.isNaN(Date.parse(deletedAt))).toBe(false);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'store.order.recycled',
        resourceId: 'order',
        actorId: 'buyer',
        ip: '10.0.0.1',
      }),
    );
  });

  it('refuses to recycle when the order vanished under a concurrent write', async () => {
    mocks.findOrderForUser.mockResolvedValue(order());
    mocks.setOrderDeletedAt.mockResolvedValue(false);
    await expect(recycleMyOrder(req())).rejects.toMatchObject({ status: 409 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('order recycle restore (admin)', () => {
  it('404s an unknown order and 409s an order that is not in the bin', async () => {
    mocks.getOrder.mockResolvedValue(null);
    await expect(restoreRecycledOrder(req())).rejects.toMatchObject({ status: 404 });
    mocks.getOrder.mockResolvedValue(order({ deletedAt: null }));
    await expect(restoreRecycledOrder(req())).rejects.toMatchObject({ status: 409 });
    expect(mocks.setOrderDeletedAt).not.toHaveBeenCalled();
  });

  it('clears deletedAt and records the audit', async () => {
    mocks.getOrder.mockResolvedValue(order({ deletedAt: '2026-01-01T00:00:00.000Z' }));
    expect(await restoreRecycledOrder(req())).toEqual({ restored: true, orderId: 'order' });
    expect(mocks.setOrderDeletedAt).toHaveBeenCalledWith('order', null);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'store.order.restored', resourceId: 'order' }),
    );
  });
});

describe('recycle bin purge', () => {
  it('only touches orders recycled longer than the retention window', async () => {
    mocks.listRecycledOrdersBefore.mockResolvedValue([
      order({ deletedAt: '2025-12-01T00:00:00.000Z' }),
    ]);
    mocks.deleteOrderInstance.mockResolvedValue(undefined);
    const now = new Date('2026-01-31T00:00:00.000Z');
    expect(await purgeRecycledOrders(now)).toEqual({ scanned: 1, purged: 1 });
    const [cutoff] = mocks.listRecycledOrdersBefore.mock.calls[0] as [string, number];
    expect(Date.parse(cutoff)).toBe(now.getTime() - RECYCLE_RETENTION_MS);
    // 真删之后只剩审计能证明这单存在过，金额与币种必须一起记下。
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'store.order.purged',
        resourceId: 'order',
        meta: expect.objectContaining({ total: 9900, currency: 'CNY' }),
      }),
    );
  });

  it('keeps going when one row fails and reports the real count', async () => {
    mocks.listRecycledOrdersBefore.mockResolvedValue([order({ id: 'a' }), order({ id: 'b' })]);
    mocks.deleteOrderInstance
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce(undefined);
    expect(await purgeRecycledOrders(new Date('2026-01-31T00:00:00.000Z'))).toEqual({
      scanned: 2,
      purged: 1,
    });
    expect(mocks.warn).toHaveBeenCalled();
  });

  it('does nothing when the bin is empty', async () => {
    mocks.listRecycledOrdersBefore.mockResolvedValue([]);
    expect(await purgeRecycledOrders()).toEqual({ scanned: 0, purged: 0 });
    expect(mocks.deleteOrderInstance).not.toHaveBeenCalled();
  });
});
