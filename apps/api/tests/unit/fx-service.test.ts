import { describe, expect, it } from 'vitest';
import { CurrencyError } from '@stackpanel/sdk';
import { FxService } from '../../src/fx/fx-service.ts';

type FxRateRow = {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  source: string;
  updatedBy: string | null;
  updatedAt: Date;
  validUntil?: Date | null;
};

function makeService(
  rates: FxRateRow[],
  options: { settlement?: string } = {},
): FxService {
  const db = {
    fxRate: {
      findUnique: async ({
        where,
      }: {
        where: { fromCurrency_toCurrency: { fromCurrency: string; toCurrency: string } };
      }) =>
        rates.find(
          (r) =>
            r.fromCurrency === where.fromCurrency_toCurrency.fromCurrency &&
            r.toCurrency === where.fromCurrency_toCurrency.toCurrency,
        ) ?? null,
      findMany: async () => rates,
    },
    setting: {
      findUnique: async () => (options.settlement ? { value: options.settlement } : null),
    },
  };
  return new FxService({ db: db as never });
}

const row = (overrides: Partial<FxRateRow> = {}): FxRateRow => ({
  id: 'r1',
  fromCurrency: 'USD',
  toCurrency: 'CNY',
  rate: 7_200_000,
  source: 'manual',
  updatedBy: null,
  updatedAt: new Date(),
  validUntil: null,
  ...overrides,
});

describe('FxService', () => {
  it('returns the amount unchanged when currencies match (rate null)', async () => {
    const fx = makeService([]);
    const quote = await fx.quote('CNY', 'CNY', 7200);
    expect(quote.rate).toBeNull();
    expect(quote.settlementAmount).toBe(7200);
  });

  it('converts minor units at a frozen ×1e6 rate', async () => {
    const fx = makeService([row()]);
    // 100000 USD minor (1000.00) × 7.2 → 720000 CNY minor (7200.00)
    const quote = await fx.quote('USD', 'CNY', 100000);
    expect(quote.rate).toBe(7_200_000);
    expect(quote.settlementAmount).toBe(720000);
  });

  it('rounds the settlement amount', async () => {
    const fx = makeService([row({ id: 'r2', fromCurrency: 'EUR', rate: 7_650_000 })]);
    // 1 EUR minor × 7.65 = 7.65 → rounds to 8
    const quote = await fx.quote('EUR', 'CNY', 1);
    expect(quote.settlementAmount).toBe(8);
  });

  it('throws 409 when no rate is configured for the pair', async () => {
    const fx = makeService([]);
    await expect(fx.quote('USD', 'CNY', 1000)).rejects.toBeInstanceOf(CurrencyError);
    await expect(fx.quote('USD', 'CNY', 1000)).rejects.toMatchObject({
      status: 409,
      code: 'currency.rate_missing',
    });
  });

  it('rejects an expired rate instead of settling silently', async () => {
    const fx = makeService([row({ validUntil: new Date(Date.now() - 60_000) })]);
    await expect(fx.quote('USD', 'CNY', 1000)).rejects.toMatchObject({
      status: 409,
      code: 'currency.rate_expired',
    });
  });

  it('accepts a rate whose validity is still in the future', async () => {
    const fx = makeService([row({ validUntil: new Date(Date.now() + 60_000) })]);
    await expect(fx.quote('USD', 'CNY', 1000)).resolves.toMatchObject({ rate: 7_200_000 });
  });

  it('rejects unknown currencies before any rate lookup', async () => {
    const fx = makeService([row()]);
    await expect(fx.quote('BTC', 'CNY', 1000)).rejects.toMatchObject({
      code: 'currency.invalid',
    });
    await expect(fx.quote('USD', 'XYZ', 1000)).rejects.toMatchObject({
      code: 'currency.invalid',
    });
  });

  it('normalizes case and aliases in the pair', async () => {
    const fx = makeService([row()]);
    await expect(fx.quote('usd', 'cny', 1000)).resolves.toMatchObject({ rate: 7_200_000 });
  });

  it('rejects invalid amounts', async () => {
    const fx = makeService([]);
    await expect(fx.quote('USD', 'CNY', -1)).rejects.toMatchObject({ status: 400 });
  });

  it('keeps exact precision for large amounts where float would lose precision', async () => {
    const fx = makeService([row({ id: 'r3' })]);
    // amount×rate exceeds 2^53; BigInt keeps it exact.
    const quote = await fx.quote('USD', 'CNY', 2_000_000_000);
    expect(quote.settlementAmount).toBe(14_400_000_000);
  });

  it('honours differing minor units (USD→JPY)', async () => {
    const fx = makeService([row({ fromCurrency: 'USD', toCurrency: 'JPY', rate: 150_000_000 })]);
    // 10.00 USD × 150 = 1500 JPY (0 decimals)
    const quote = await fx.quote('USD', 'JPY', 1_000);
    expect(quote.settlementAmount).toBe(1_500);
  });

  it('lists configured rates', async () => {
    const fx = makeService([row()]);
    const rates = await fx.listRates();
    expect(rates).toHaveLength(1);
    expect(rates[0]?.fromCurrency).toBe('USD');
  });
});

describe('FxService settlement currency', () => {
  it('defaults to CNY when the setting is absent', async () => {
    const fx = makeService([]);
    await expect(fx.getSettlementCurrency()).resolves.toBe('CNY');
  });

  it('reads the settlement currency from platform settings', async () => {
    const fx = makeService([], { settlement: 'USD' });
    await expect(fx.getSettlementCurrency()).resolves.toBe('USD');
  });

  it('normalizes a legacy/aliased settlement setting', async () => {
    const fx = makeService([], { settlement: 'rmb' });
    await expect(fx.getSettlementCurrency()).resolves.toBe('CNY');
  });

  it('quoteToSettlement converts into the configured settlement currency', async () => {
    const fx = makeService([row({ fromCurrency: 'CNY', toCurrency: 'USD', rate: 138_889 })], {
      settlement: 'USD',
    });
    const quote = await fx.quoteToSettlement('CNY', 10_000);
    expect(quote.toCurrency).toBe('USD');
    expect(quote.settlementAmount).toBe(1_389);
  });
});
