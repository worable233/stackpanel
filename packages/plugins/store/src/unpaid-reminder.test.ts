import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listOrdersToRemind: vi.fn(),
  claimUnpaidReminder: vi.fn(),
  releaseUnpaidReminder: vi.fn(),
  getOrder: vi.fn(),
  notifyCreate: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./repository', async (original) => ({
  ...(await original<typeof import('./repository')>()),
  listOrdersToRemind: mocks.listOrdersToRemind,
  claimUnpaidReminder: mocks.claimUnpaidReminder,
  releaseUnpaidReminder: mocks.releaseUnpaidReminder,
  getOrder: mocks.getOrder,
}));

vi.mock('./context', async (original) => ({
  ...(await original<typeof import('./context')>()),
  context: () => ({ notifications: { create: mocks.notifyCreate } }),
  logger: () => ({ info: mocks.info, warn: mocks.warn, error: vi.fn() }),
}));

import { runUnpaidOrderReminder, UNPAID_REMIND_AFTER_MS } from './unpaid-reminder';

const order = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-1',
  userId: 'buyer',
  items: { items: [] },
  total: 9900,
  currency: 'CNY',
  status: 'PENDING',
  channelCode: null,
  settlementCurrency: 'CNY',
  settlementTotal: 9900,
  fxRate: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimUnpaidReminder.mockResolvedValue(true);
  mocks.getOrder.mockImplementation(async (id: string) => order({ id }));
  mocks.notifyCreate.mockResolvedValue(undefined);
  mocks.releaseUnpaidReminder.mockResolvedValue(true);
});

describe('未付款订单催付', () => {
  it('到点且仍未支付：发一条提醒，并把订单标记为已催付', async () => {
    mocks.listOrdersToRemind.mockResolvedValue([order()]);
    const now = new Date('2026-01-15T00:00:00Z');

    await runUnpaidOrderReminder(now);

    // 催付是「按计划时间戳」驱动：截止时间就是 now，任务晚跑几天照样补发。
    expect(mocks.listOrdersToRemind).toHaveBeenCalledWith(now.getTime(), expect.any(Number));
    expect(mocks.claimUnpaidReminder).toHaveBeenCalledWith('order-1', now);
    expect(mocks.notifyCreate).toHaveBeenCalledTimes(1);
    const payload = mocks.notifyCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.type).toBe('order.unpaid');
    expect(payload.link).toBe('/account/orders/order-1');
    // 金额按分转元：9900 分 → 99.00 CNY。
    expect(payload.body).toContain('99.00 CNY');
  });

  it('认领失败（别的副本已处理）时不重复发', async () => {
    mocks.listOrdersToRemind.mockResolvedValue([order()]);
    mocks.claimUnpaidReminder.mockResolvedValue(false);

    await runUnpaidOrderReminder(new Date());

    expect(mocks.notifyCreate).not.toHaveBeenCalled();
  });

  it('认领后才发现订单已支付：不发', async () => {
    mocks.listOrdersToRemind.mockResolvedValue([order()]);
    mocks.getOrder.mockResolvedValue(order({ status: 'PAID' }));

    await runUnpaidOrderReminder(new Date());

    // 用户刚付完款就收到「请尽快支付」是最招投诉的 bug。
    expect(mocks.notifyCreate).not.toHaveBeenCalled();
  });

  it('通知失败把标记退回未催付，下一轮重试', async () => {
    mocks.listOrdersToRemind.mockResolvedValue([order()]);
    mocks.notifyCreate.mockRejectedValue(new Error('notifications down'));

    await runUnpaidOrderReminder(new Date());

    expect(mocks.releaseUnpaidReminder).toHaveBeenCalledWith('order-1');
    expect(mocks.warn).toHaveBeenCalled();
  });

  it('催付窗口是下单后 24 小时', () => {
    expect(UNPAID_REMIND_AFTER_MS).toBe(24 * 60 * 60 * 1000);
  });
});
