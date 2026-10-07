import { describe, expect, it, vi } from 'vitest';
import {
  createTranslator,
  formatCurrency,
  formatMessage,
  formatMoney,
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
