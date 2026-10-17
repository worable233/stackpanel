import { describe, expect, it } from 'vitest';
import { formatAmountPair, sameCurrency, tryNormalizeCurrency } from './currency';

describe('store currency helpers', () => {
  it('normalizes aliases and case to catalog codes', () => {
    expect(tryNormalizeCurrency('rmb')).toBe('CNY');
    expect(tryNormalizeCurrency('usd')).toBe('USD');
    expect(tryNormalizeCurrency('yen')).toBe('JPY');
    expect(tryNormalizeCurrency('BTC')).toBeNull();
    expect(tryNormalizeCurrency(null)).toBeNull();
  });

  it('compares currencies through the catalog, not raw strings', () => {
    expect(sameCurrency('rmb', 'CNY')).toBe(true);
    expect(sameCurrency('usd', 'USD')).toBe(true);
    expect(sameCurrency('USD', 'CNY')).toBe(false);
    expect(sameCurrency('BTC', 'BTC')).toBe(false);
  });

  it('collapses the amount pair when both sides use the same currency', () => {
    expect(
      formatAmountPair({
        total: 123_45,
        currency: 'CNY',
        settlementTotal: 123_45,
        settlementCurrency: 'RMB',
      }),
    ).toBe('¥123.45');
  });

  it('shows both the original and settlement amounts when they differ', () => {
    const text = formatAmountPair({
      total: 10_000,
      currency: 'USD',
      settlementTotal: 720_00,
      settlementCurrency: 'CNY',
    });
    expect(text).toContain('$100.00');
    expect(text).toContain('¥720.00');
    expect(text).toContain('结算');
  });

  it('respects a zero-decimal settlement currency', () => {
    const text = formatAmountPair({
      total: 10_00,
      currency: 'USD',
      settlementTotal: 14_400,
      settlementCurrency: 'JPY',
    });
    expect(text).toContain('$10.00');
    expect(text).toContain('14,400');
  });
});
