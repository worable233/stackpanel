import { describe, expect, it } from 'vitest';
import { negotiateLocale, parseAcceptLanguage } from '@/i18n/negotiate';

describe('parseAcceptLanguage', () => {
  it('orders ranges by descending q-value', () => {
    const ranges = parseAcceptLanguage('en-US;q=0.7, zh-CN;q=0.9');
    expect(ranges.map((r) => r.tag)).toEqual(['zh-CN', 'en-US']);
  });

  it('defaults q to 1 and drops q=0', () => {
    const ranges = parseAcceptLanguage('fr, en;q=0');
    expect(ranges.map((r) => r.tag)).toEqual(['fr']);
  });

  it('handles an empty or missing header', () => {
    expect(parseAcceptLanguage('')).toEqual([]);
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
  });
});

describe('negotiateLocale', () => {
  it('matches an exact shipped tag', () => {
    expect(negotiateLocale('en-US,en;q=0.9')).toBe('en-US');
    expect(negotiateLocale('zh-CN')).toBe('zh-CN');
  });

  it('resolves a base language to the shipped region', () => {
    expect(negotiateLocale('en')).toBe('en-US');
  });

  it('respects quality ordering when several shipped locales match', () => {
    expect(negotiateLocale('en;q=0.4, zh-CN;q=0.9')).toBe('zh-CN');
  });

  it('falls back to the default for unknown languages or empty headers', () => {
    expect(negotiateLocale('fr-FR,de;q=0.8')).toBe('zh-CN');
    expect(negotiateLocale('')).toBe('zh-CN');
    expect(negotiateLocale(null)).toBe('zh-CN');
  });

  it('treats a wildcard as the fallback', () => {
    expect(negotiateLocale('*')).toBe('zh-CN');
  });
});
