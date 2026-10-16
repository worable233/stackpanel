import type { PrismaClient } from '@stackpanel/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalletService } from '../../src/wallet/wallet-service.ts';

type Entry = { userId: string; currency: string; type: string; amount: number; createdAt: Date };
function service(entries: Entry[]) {
  const aggregate = vi.fn(async ({ where }: {
    where: { userId: string; currency: string; amount: { lt: number }; type: { not: string }; createdAt: { gte: Date; lt: Date } };
  }) => ({ _sum: { amount: entries.filter(entry =>
    entry.userId === where.userId && entry.currency === where.currency &&
    entry.amount < where.amount.lt && entry.type !== where.type.not &&
    entry.createdAt >= where.createdAt.gte && entry.createdAt < where.createdAt.lt,
  ).reduce((sum, entry) => sum + entry.amount, 0) } }));
  return new WalletService({ db: { walletLedgerEntry: { aggregate } } as unknown as PrismaClient });
}

afterEach(() => vi.useRealTimers());

describe('wallet monthly spending', () => {
  it('uses Shanghai calendar boundaries across years and includes more than 50 debits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-31T16:30:00Z')); // February in Shanghai
    const entry: Entry = { userId: 'alice', currency: 'CNY', type: 'ORDER_PAYMENT', amount: -100, createdAt: new Date('2026-01-31T16:00:00Z') };
    const entries = [
      ...Array.from({ length: 80 }, () => ({ ...entry })),
      { ...entry, amount: -700, type: 'llm_gateway_usage' },
      { ...entry, amount: -300, createdAt: new Date('2026-01-31T15:59:59.999Z') },
      { ...entry, amount: -500, createdAt: new Date('2025-02-28T16:00:00Z') },
      { ...entry, amount: -900, createdAt: new Date('2025-02-28T15:59:59.999Z') },
      { ...entry, amount: -900, createdAt: new Date('2026-02-28T16:00:00Z') },
      { ...entry, amount: 500, type: 'ORDER_REFUND' },
      { ...entry, amount: 500, type: 'TOP_UP' },
      { ...entry, amount: -500, type: 'ADMIN_ADJUST' },
      { ...entry, userId: 'bob' },
      { ...entry, currency: 'USD' },
    ];
    const result = await service(entries).getMonthlySpending('alice');
    expect(result).toHaveLength(12);
    expect(result[0]).toEqual({ month: '2025-03', amount: 500 });
    expect(result.at(-2)).toEqual({ month: '2026-01', amount: 300 });
    expect(result.at(-1)).toEqual({ month: '2026-02', amount: 8700 });
    expect(result.reduce((sum, month) => sum + month.amount, 0)).toBe(9500);
  });

  it('returns twelve zero months for a new wallet', async () => {
    const result = await service([]).getMonthlySpending('new-user');
    expect(result).toHaveLength(12);
    expect(result.every(month => month.amount === 0)).toBe(true);
  });
});
