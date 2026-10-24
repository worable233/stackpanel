import { describe, expect, it } from 'vitest';
import {
  createPackageTranslator,
  formatPackageMessage,
  packageLocaleChain,
  PACKAGE_FALLBACK_LOCALE,
} from '../src/i18n.js';

const catalogs = {
  'zh-CN': { 'page.title': '商店', 'cart.count': '共 {count} 件' },
  'en-US': { 'page.title': 'Store' },
};

describe('createPackageTranslator', () => {
  it('resolves the requested locale', () => {
    expect(createPackageTranslator('en-US', catalogs)('page.title')).toBe('Store');
  });

  it('falls back to the declared locales in order', () => {
    expect(createPackageTranslator('ja-JP', catalogs, ['zh-CN'])('page.title')).toBe('商店');
    expect(createPackageTranslator('ja-JP', catalogs, ['ja-JP', 'en-US'])('page.title')).toBe(
      'Store',
    );
  });

  it('returns the id when nothing matches, so a gap is visible', () => {
    expect(createPackageTranslator('ja-JP', catalogs)('page.title')).toBe('page.title');
    expect(createPackageTranslator(undefined, catalogs, [])('page.title')).toBe('page.title');
  });

  it('interpolates placeholders and leaves unknown ones visible', () => {
    const tr = createPackageTranslator('zh-CN', catalogs);
    expect(tr('cart.count', { count: 3 })).toBe('共 3 件');
    expect(tr('cart.count')).toBe('共 {count} 件');
  });

  it('resolves a base language to the shipped region', () => {
    expect(createPackageTranslator('en', catalogs)('page.title')).toBe('Store');
  });

  it('never resolves Traditional Chinese to the Simplified catalog', () => {
    const traditional = {
      'zh-CN': { 'page.title': '商店' },
      'zh-TW': { 'page.title': '商店（臺）' },
      'zh-HK': { 'page.title': '商店（港）' },
    };
    expect(createPackageTranslator('zh-Hant', traditional)('page.title')).toBe('商店（臺）');
    expect(createPackageTranslator('zh-Hant-HK', traditional)('page.title')).toBe('商店（港）');
    expect(createPackageTranslator('zh-MO', traditional)('page.title')).toBe('商店（港）');
    expect(createPackageTranslator('zh-Hans-CN', traditional)('page.title')).toBe('商店');
  });
});

describe('packageLocaleChain', () => {
  it('orders candidates from most to least specific', () => {
    const traditional = {
      'zh-CN': {},
      'zh-TW': {},
      'zh-HK': {},
      'en-US': {},
    };
    expect(packageLocaleChain('zh-Hant-HK', traditional)).toEqual(['zh-HK', 'zh-TW', 'zh-CN']);
    expect(packageLocaleChain('en-GB', traditional)).toEqual(['en-US']);
  });

  it('returns an empty chain for an unsupported language', () => {
    expect(packageLocaleChain('ja-JP', catalogs)).toEqual([]);
    expect(packageLocaleChain(undefined, catalogs)).toEqual([]);
  });
});

describe('formatPackageMessage', () => {
  it('returns the template untouched without params', () => {
    expect(formatPackageMessage('共 {count} 件')).toBe('共 {count} 件');
  });

  it('does not treat inherited properties as params', () => {
    expect(formatPackageMessage('{toString}', {})).toBe('{toString}');
  });
});

describe('PACKAGE_FALLBACK_LOCALE', () => {
  it('matches the kernel site default', () => {
    expect(PACKAGE_FALLBACK_LOCALE).toBe('zh-CN');
  });
});

describe('frontend manifest catalogs survive validation', () => {
  it('keeps messages and locales so the host can translate package metadata', async () => {
    const { frontendManifestSchema } = await import('../src/schemas.js');
    const parsed = frontendManifestSchema.parse({
      version: '1',
      revision: 'r1',
      entry: 'index.js',
      files: ['index.js'],
      locales: ['zh-CN', 'en-US'],
      messages: { 'zh-CN': { 'nav.label': '商店' }, 'en-US': { 'nav.label': 'Store' } },
    });
    expect(parsed.messages?.['en-US']?.['nav.label']).toBe('Store');
    expect(parsed.locales).toEqual(['zh-CN', 'en-US']);
  });

  it('rejects oversized catalogs instead of carrying them per request', async () => {
    const { frontendManifestSchema } = await import('../src/schemas.js');
    const messages = {
      'zh-CN': Object.fromEntries(Array.from({ length: 4001 }, (_, i) => [`key.${i}`, 'v'])),
    };
    const result = frontendManifestSchema.safeParse({
      version: '1',
      revision: 'r1',
      entry: 'index.js',
      files: ['index.js'],
      messages,
    });
    expect(result.success).toBe(false);
  });
});
