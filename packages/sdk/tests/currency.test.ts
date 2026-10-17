import { describe, expect, it } from 'vitest';
import {
  CURRENCY_ALIASES,
  CurrencyError,
  assertCurrency,
  convertMinorUnits,
  findCurrency,
  formatMinorCurrency,
  minorUnitFor,
  minorUnitsToPlainString,
  normalizeCurrencyCode,
  toMajorUnits,
  toMinorUnits,
} from '../src/currency.js';

/** Capture a thrown error so tests can assert on its stable `code`. */
function catchError(fn: () => unknown): { code?: string; status?: number } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; status?: number };
  }
  throw new Error('expected the call to throw');
}

describe('currency catalog', () => {
  it('normalizes case and documented aliases', () => {
    expect(normalizeCurrencyCode('cny')).toBe('CNY');
    expect(normalizeCurrencyCode(' usd ')).toBe('USD');
    expect(normalizeCurrencyCode('RMB')).toBe('CNY');
    expect(normalizeCurrencyCode('rmb')).toBe(CURRENCY_ALIASES['RMB']);
  });

  it('rejects unknown and free-text codes', () => {
    expect(normalizeCurrencyCode('XYZ')).toBeNull();
    expect(normalizeCurrencyCode('比特币')).toBeNull();
    expect(normalizeCurrencyCode('')).toBeNull();
    expect(normalizeCurrencyCode(undefined)).toBeNull();
    expect(() => assertCurrency('BTC')).toThrow(CurrencyError);
    expect(catchError(() => assertCurrency('BTC'))).toMatchObject({ code: 'currency.invalid' });
  });

  it('exposes minor units per ISO 4217', () => {
    expect(minorUnitFor('CNY')).toBe(2);
    expect(minorUnitFor('USD')).toBe(2);
    expect(minorUnitFor('JPY')).toBe(0);
    expect(minorUnitFor('KRW')).toBe(0);
  });
});

describe('toMinorUnits', () => {
  it('parses two-decimal currencies', () => {
    expect(toMinorUnits('12.34', 'CNY')).toBe(1234);
    expect(toMinorUnits(12.34, 'USD')).toBe(1234);
    expect(toMinorUnits('0.01', 'EUR')).toBe(1);
  });

  it('parses zero-decimal currencies without inventing cents', () => {
    expect(toMinorUnits('1234', 'JPY')).toBe(1234);
    expect(toMinorUnits(1234, 'KRW')).toBe(1234);
  });

  it('rejects excess fraction digits instead of truncating', () => {
    expect(catchError(() => toMinorUnits('1.005', 'CNY'))).toMatchObject({ code: 'currency.minor_unit_invalid' });
    expect(catchError(() => toMinorUnits('1.5', 'JPY'))).toMatchObject({ code: 'currency.minor_unit_invalid' });
  });

  it('rejects malformed and unsafe amounts', () => {
    expect(catchError(() => toMinorUnits('abc', 'CNY'))).toMatchObject({ code: 'currency.minor_unit_invalid' });
    expect(catchError(() => toMinorUnits('1e5', 'CNY'))).toMatchObject({ code: 'currency.minor_unit_invalid' });
    expect(catchError(() => toMinorUnits('999999999999999999999', 'CNY'))).toMatchObject({ code: 'currency.minor_unit_invalid' });
  });

  it('rejects an unknown currency', () => {
    expect(catchError(() => toMinorUnits('1', 'BTC'))).toMatchObject({ code: 'currency.invalid' });
  });
});

describe('formatting', () => {
  it('converts minor units to major units by catalog precision', () => {
    expect(toMajorUnits(1234, 'CNY')).toBe(12.34);
    expect(toMajorUnits(1234, 'JPY')).toBe(1234);
  });

  it('produces an exact plain string for form inputs', () => {
    expect(minorUnitsToPlainString(1234, 'CNY')).toBe('12.34');
    expect(minorUnitsToPlainString(5, 'CNY')).toBe('0.05');
    expect(minorUnitsToPlainString(1234, 'JPY')).toBe('1234');
    expect(minorUnitsToPlainString(-1234, 'USD')).toBe('-12.34');
  });

  it('formats with the currency symbol and no CNY special case', () => {
    expect(formatMinorCurrency(1234, 'USD', 'en-US')).toContain('$');
    expect(formatMinorCurrency(1234, 'EUR', 'de-DE')).toContain('€');
    // JPY renders without decimals.
    expect(formatMinorCurrency(1234, 'JPY', 'ja-JP')).not.toContain('.');
  });
});

describe('convertMinorUnits', () => {
  it('converts between currencies with the same minor unit', () => {
    // 1000.00 USD × 7.2 = 7200.00 CNY
    expect(convertMinorUnits(100_000, 'USD', 'CNY', 7_200_000)).toBe(720_000);
  });

  it('respects differing minor units (USD 2dp → JPY 0dp)', () => {
    // 10.00 USD (1000 minor) × 150 = 1500 JPY (1500 minor units, no decimals)
    expect(convertMinorUnits(1_000, 'USD', 'JPY', 150_000_000)).toBe(1_500);
    // 1500 JPY (1500 minor) × (1/150) ≈ 10.00 USD → 1000 minor units
    expect(convertMinorUnits(1_500, 'JPY', 'USD', Math.round(1_000_000 / 150))).toBe(1_000);
  });

  it('rounds half-up exactly with BigInt', () => {
    // 1 EUR cent × 7.65 = 7.65 → 8
    expect(convertMinorUnits(1, 'EUR', 'CNY', 7_650_000)).toBe(8);
    // 1 × 7.64 = 7.64 → 8 (half-up from .64 of a cent... rounds down to 8? no: 7.64 → 8)
    expect(convertMinorUnits(1, 'EUR', 'CNY', 7_640_000)).toBe(8);
    // 1 × 7.4 = 7.4 → 7
    expect(convertMinorUnits(1, 'EUR', 'CNY', 7_400_000)).toBe(7);
  });

  it('keeps exactness for amounts beyond float precision', () => {
    expect(convertMinorUnits(2_000_000_000, 'USD', 'CNY', 7_200_000)).toBe(14_400_000_000);
  });

  it('rejects unknown currencies and invalid rates', () => {
    expect(catchError(() => convertMinorUnits(100, 'BTC', 'CNY', 1_000_000))).toMatchObject({ code: 'currency.invalid' });
    expect(catchError(() => convertMinorUnits(100, 'USD', 'CNY', 0))).toMatchObject({ code: 'currency.rate_missing' });
  });
});

describe('catalog lookup', () => {
  it('finds entries case-insensitively and returns null otherwise', () => {
    expect(findCurrency('usd')?.code).toBe('USD');
    expect(findCurrency('RMB')?.code).toBe('CNY');
    expect(findCurrency('NOPE')).toBeNull();
  });
});
