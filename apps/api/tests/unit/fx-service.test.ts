import { describe, expect, it } from 'vitest';
import { FxError } from '@stackpanel/sdk';
import { FxService } from '../../src/fx/fx-service.ts';

type FxRateRow = {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  source: string;
  updatedBy: string | null;
  updatedAt: Date;
};

function makeService(rates: FxRateRow[]): FxService {
  const db = {
    fxRate: {
      findUnique: async ({ where }: { where: { fromCurrency_toCurrency: { fromCurrency: string; toCurrency: string } } }) =>
        rates.find(
          (r) =>
            r.fromCurrency === where.fromCurrency_toCurrency.fromCurrency &&
            r.toCurrency === where.fromCurrency_toCurrency.toCurrency,
        ) ?? null,
      findMany: async () => rates,
    },
  };
  return new FxService({ db: db as never });
}

describe('FxService', () => {
  it('returns the amount unchanged when currencies match (rate null)', async () => {
    const fx = makeService([]);
    const quote = await fx.quote('CNY', 'CNY', 7200);
    expect(quote.rate).toBeNull();
    expect(quote.settlementAmount).toBe(7200);
  });

  it('converts minor units at a frozen ×1e6 rate', async () => {
    const fx = makeService([
      { id: 'r1', fromCurrency: 'USD', toCurrency: 'CNY', rate: 7_200_000, source: 'manual', updatedBy: null, updatedAt: new Date() },
    ]);
    // 100000 USD minor (1000.00) × 7.2 → 720000 CNY minor (7200.00)
    const quote = await fx.quote('USD', 'CNY', 100000);
    expect(quote.rate).toBe(7_200_000);
    expect(quote.settlementAmount).toBe(720000);
  });

  it('rounds the settlement amount', async () => {
    const fx = makeService([
      { id: 'r2', fromCurrency: 'EUR', toCurrency: 'CNY', rate: 7_650_000, source: 'manual', updatedBy: null, updatedAt: new Date() },
    ]);
    // 1 EUR minor × 7.65 = 7.65 → rounds to 8
    const quote = await fx.quote('EUR', 'CNY', 1);
    expect(quote.settlementAmount).toBe(8);
  });

  it('throws 409 when no rate is configured for the pair', async () => {
    const fx = makeService([]);
    await expect(fx.quote('USD', 'CNY', 1000)).rejects.toBeInstanceOf(FxError);
    await expect(fx.quote('USD', 'CNY', 1000)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects invalid amounts', async () => {
    const fx = makeService([]);
    await expect(fx.quote('USD', 'CNY', -1)).rejects.toMatchObject({ status: 400 });
  });

  it('keeps exact precision for large amounts where float would lose precision', async () => {
    const fx = makeService([
      { id: 'r3', fromCurrency: 'USD', toCurrency: 'CNY', rate: 7_200_000, source: 'manual', updatedBy: null, updatedAt: new Date() },
    ]);
    // amount×rate exceeds 2^53; BigInt keeps it exact.
    const quote = await fx.quote('USD', 'CNY', 2_000_000_000);
    expect(quote.settlementAmount).toBe(14_400_000_000);
  });

  it('lists configured rates', async () => {
    const fx = makeService([
      { id: 'r1', fromCurrency: 'USD', toCurrency: 'CNY', rate: 7_200_000, source: 'manual', updatedBy: null, updatedAt: new Date() },
    ]);
    const rates = await fx.listRates();
    expect(rates).toHaveLength(1);
    expect(rates[0]?.fromCurrency).toBe('USD');
  });
});
