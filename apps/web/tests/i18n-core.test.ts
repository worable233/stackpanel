import { describe, expect, it, vi } from 'vitest';
import {
  createTranslator,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatFileSize,
  formatList,
  formatMessage,
  formatMoney,
  formatPercent,
  formatPlural,
  formatRelativeTime,
  formatUnit,
  lookupMessage,
  lookupTranslation,
  translate,
} from '@/i18n/core';

describe('lookupMessage', () => {
  const catalog = { a: { b: { c: 'value' } }, flat: 'x' };

  it('resolves a dotted path', () => {
    expect(lookupMessage(catalog, 'a.b.c')).toBe('value');
  });

  it('returns undefined for a missing path', () => {
    expect(lookupMessage(catalog, 'a.b.z')).toBeUndefined();
    expect(lookupMessage(catalog, 'a.x.c')).toBeUndefined();
  });

  it('returns undefined when the target is not a string', () => {
    expect(lookupMessage(catalog, 'a.b')).toBeUndefined();
  });
});

describe('formatMessage', () => {
  it('interpolates named params', () => {
    expect(formatMessage('hello {name}', { name: 'world' })).toBe('hello world');
  });

  it('leaves unknown placeholders intact', () => {
    expect(formatMessage('hi {missing}', { name: 'x' })).toBe('hi {missing}');
  });

  it('returns the template when no params are given', () => {
    expect(formatMessage('plain')).toBe('plain');
  });
});

describe('translate', () => {
  it('resolves a shipped message for the requested locale', () => {
    expect(translate('zh-CN', 'auth.login.title')).toBe('登录你的账户');
    expect(translate('en-US', 'auth.login.title')).toBe('Login to your account');
  });

  it('falls back to the default locale for a missing locale key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Override the en-US `auth` namespace with an empty object so the key is
    // missing there and the default (zh-CN) catalog must supply it.
    const value = translate('en-US', 'auth.login.title', undefined, { 'en-US': { auth: {} } });
    expect(value).toBe('登录你的账户');
    warn.mockRestore();
  });

  it('returns the key itself when nothing matches', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(translate('en-US', 'does.not.exist')).toBe('does.not.exist');
    warn.mockRestore();
  });

  it('interpolates params through the fallback chain', () => {
    const value = translate(
      'en-US',
      'user.created',
      { email: 'a@b.com' },
      { 'en-US': { user: {} } },
    );
    expect(value).toBe('用户 a@b.com 已创建。');
  });
});

describe('lookupTranslation', () => {
  it('returns undefined instead of the key when missing', () => {
    expect(lookupTranslation('en-US', 'does.not.exist')).toBeUndefined();
  });
});

describe('createTranslator', () => {
  it('binds a locale', () => {
    const t = createTranslator('en-US');
    expect(t('common.save')).toBe('Save');
  });
});

describe('formatCurrency', () => {
  it('presents the amount in the requested locale', () => {
    expect(formatCurrency(1234.5, 'CNY', 'zh-CN')).toBe('¥1,234.50');
    expect(formatCurrency(1234.5, 'CNY', 'en-US')).toBe('CN¥1,234.50');
  });

  it('keeps the settlement currency independent of the locale', () => {
    expect(formatCurrency(1234.5, 'USD', 'zh-CN')).toBe('US$1,234.50');
    expect(formatCurrency(1234.5, 'USD', 'en-US')).toBe('$1,234.50');
  });
});

describe('formatMoney', () => {
  it('divides minor units by 100 for two-decimal currencies', () => {
    expect(formatMoney(1234, 'USD', 'en-US')).toBe('$12.34');
    expect(formatMoney(123400, 'CNY', 'zh-CN', { maximumFractionDigits: 0 })).toBe('¥1,234');
  });

  it('does not divide zero-decimal currencies', () => {
    expect(formatMoney(1234, 'JPY', 'en-US')).toBe('¥1,234');
    expect(formatMoney(1234, 'jpy', 'en-US')).toBe('¥1,234');
  });

  it('follows the locale for grouping and symbol placement', () => {
    expect(formatMoney(123456789, 'CNY', 'zh-CN')).toBe('¥1,234,567.89');
    expect(formatMoney(123456789, 'CNY', 'en-US')).toBe('CN¥1,234,567.89');
  });
});

describe('formatDateTime', () => {
  it('matches formatDate for the same value and options', () => {
    const value = new Date('2026-01-02T03:04:00Z');
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: 'medium',
      timeZone: 'UTC',
    };
    expect(formatDateTime(value, 'en-US', options)).toBe(formatDate(value, 'en-US', options));
    expect(formatDateTime(value, 'zh-CN', options)).toBe('2026年1月2日');
  });
});

describe('formatPercent', () => {
  it('renders a ratio as a percentage per locale', () => {
    expect(formatPercent(0.42, 'en-US')).toBe('42%');
    expect(formatPercent(0.42, 'zh-CN')).toBe('42%');
  });

  it('accepts Intl options (e.g. fixed fraction digits)', () => {
    expect(formatPercent(0.1234, 'en-US', { maximumFractionDigits: 1 })).toBe('12.3%');
  });
});

describe('formatUnit', () => {
  it('localises the unit name', () => {
    expect(formatUnit(3, 'kilometer', 'en-US')).toBe('3 km');
    expect(formatUnit(3, 'kilometer', 'zh-CN')).toBe('3公里');
  });
});

describe('formatFileSize', () => {
  it('scales to the largest unit that keeps the number >= 1', () => {
    expect(formatFileSize(512, 'en-US')).toBe('512B');
    expect(formatFileSize(1536, 'en-US')).toBe('1.5 kB');
    expect(formatFileSize(5 * 1024 ** 2, 'en-US')).toBe('5 MB');
    expect(formatFileSize(2 * 1024 ** 3, 'en-US')).toBe('2 GB');
  });

  it('renders the same values under either shipped locale', () => {
    // zh-CN and en-US share Latin unit abbreviations for short display; the
    // byte unit narrow form differs in spacing.
    expect(formatFileSize(2 * 1024 ** 2, 'zh-CN')).toBe('2 MB');
    expect(formatFileSize(512, 'zh-CN')).toBe('512 B');
    expect(formatFileSize(512, 'en-US')).toBe('512B');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-01-10T12:00:00Z');

  it('uses the largest whole unit and the supplied reference time', () => {
    expect(formatRelativeTime(new Date('2026-01-10T09:00:00Z'), 'en-US', { now })).toBe(
      '3 hours ago',
    );
  });

  it('localises direction and unit', () => {
    expect(formatRelativeTime(new Date('2026-01-10T09:00:00Z'), 'zh-CN', { now })).toBe('3小时前');
    expect(formatRelativeTime(new Date('2026-01-11T12:00:00Z'), 'en-US', { now })).toBe(
      'in 1 day',
    );
  });
});

describe('formatList', () => {
  it('joins items with locale-aware separators', () => {
    expect(formatList(['a', 'b', 'c'], 'en-US')).toBe('a, b, and c');
    expect(formatList(['a', 'b', 'c'], 'zh-CN')).toBe('a、b和c');
  });
});

describe('formatPlural', () => {
  const variants = { one: 'one item', other: '{n} items' } as Record<
    Intl.LDMLPluralRule,
    string
  >;

  it('selects by the locale plural rules', () => {
    expect(formatPlural(1, 'en-US', variants)).toBe('one item');
    expect(formatPlural(2, 'en-US', variants)).toBe('{n} items');
  });

  it('falls back to `other` for categories a locale does not use', () => {
    // Chinese has only `other`; count 1 resolves to `other`.
    expect(formatPlural(1, 'zh-CN', variants)).toBe('{n} items');
  });
});
