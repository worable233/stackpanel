import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  localizeSettingsSchema,
  MAX_MESSAGE_KEYS,
  packageLabel,
  packageMessage,
  readPackageMessages,
} from '@/i18n/package-messages';

describe('readPackageMessages', () => {
  it('accepts a well-formed two-locale catalog', () => {
    const { messages, issues } = readPackageMessages('store', {
      'zh-CN': { 'page.title': '商店', 'cart.empty': '购物车是空的' },
      'en-US': { 'page.title': 'Store', 'cart.empty': 'Your cart is empty' },
    });
    expect(issues).toEqual([]);
    expect(messages.locales).toEqual(['zh-CN', 'en-US']);
    expect(messages.catalogs['en-US']?.['page.title']).toBe('Store');
  });

  it('drops malformed entries but keeps the rest', () => {
    const { messages, issues } = readPackageMessages('store', {
      'zh-CN': {
        'page.title': '商店',
        'Not A Key': 'x',
        'nested.ok': 42,
        'too.long': 'x'.repeat(5000),
      },
    });
    expect(Object.keys(messages.catalogs['zh-CN'] ?? {})).toEqual(['page.title']);
    expect(issues.map((issue) => issue.reason)).toEqual([
      'invalid message id',
      'value is not a string',
      'value too long',
    ]);
  });

  it('does not shadow kernel namespaces because catalogs are package-local', () => {
    // `nav.label` is a legitimate package key: it is only ever looked up in the
    // package's own catalog, never merged into the kernel `nav.*` namespace.
    const { messages, issues } = readPackageMessages('referral', {
      'zh-CN': { 'nav.label': '我的推广' },
    });
    expect(issues).toEqual([]);
    expect(packageMessage(messages, 'zh-CN', 'nav.label')).toBe('我的推广');
  });

  it('rejects invalid language tags and non-object catalogs', () => {
    const { messages, issues } = readPackageMessages('store', {
      en_US: { 'a.b': 'x' },
      'fr-FR': 'nope',
    });
    expect(messages.locales).toEqual([]);
    expect(issues.map((issue) => issue.reason)).toEqual([
      'invalid language tag',
      'catalog is not an object',
    ]);
  });

  it('caps the number of keys per locale', () => {
    const huge: Record<string, string> = {};
    for (let i = 0; i <= MAX_MESSAGE_KEYS; i += 1) huge[`k${i}.v`] = 'x';
    const { issues } = readPackageMessages('store', { 'zh-CN': huge });
    expect(issues[0]?.reason).toContain(`${MAX_MESSAGE_KEYS} keys`);
  });
});

describe('packageMessage / packageLabel', () => {
  const { messages } = readPackageMessages('store', {
    'zh-CN': { 'page.title': '商店', 'cart.count': '共 {count} 件' },
    'en-US': { 'page.title': 'Store' },
  });

  it('follows locale → fallback chain', () => {
    expect(packageMessage(messages, 'en-US', 'page.title')).toBe('Store');
    expect(packageMessage(messages, 'ja-JP', 'page.title', ['en-US'])).toBe('Store');
    expect(packageMessage(messages, 'ja-JP', 'page.title', ['de-DE'])).toBeUndefined();
  });

  it('falls back to the literal label when the key is absent', () => {
    expect(packageLabel(messages, 'en-US', 'missing.key', 'Store')).toBe('Store');
  });

  it('prefers the resolved key over the literal label', () => {
    expect(packageLabel(messages, 'en-US', 'page.title', '商店')).toBe('Store');
  });

  it('returns the key when nothing else exists', () => {
    expect(packageLabel(undefined, 'en-US', 'page.title', undefined)).toBe('page.title');
    expect(packageLabel(undefined, 'en-US', undefined, undefined)).toBe('');
  });
});

describe('localizeSettingsSchema', () => {
  const { messages } = readPackageMessages('demo', {
    'zh-CN': { 'g.title': '标题', 'f.label': '字段', 'f.help': '说明', 'o.a': '选项 A' },
    'en-US': { 'g.title': 'Title', 'f.label': 'Field', 'f.help': 'Help', 'o.a': 'Option A' },
  });

  it('resolves group, field, help and option keys and drops the keys', () => {
    const schema = {
      groups: [
        {
          id: 'g',
          labelKey: 'g.title',
          fields: [
            {
              type: 'select' as const,
              name: 'f',
              labelKey: 'f.label',
              helpKey: 'f.help',
              options: [{ labelKey: 'o.a', value: 'a' }],
            },
          ],
        },
      ],
    };
    const out = localizeSettingsSchema(schema, messages, 'en-US', ['zh-CN']) as {
      groups: Array<{
        label?: string;
        fields: Array<{
          label?: string;
          help?: string;
          type: string;
          options: Array<{ label?: string; value: string }>;
        }>;
      }>;
    };
    expect(out.groups[0]!.label).toBe('Title');
    const field = out.groups[0]!.fields[0]!;
    expect(field.label).toBe('Field');
    expect(field.help).toBe('Help');
    expect(field).not.toHaveProperty('labelKey');
    expect(field).not.toHaveProperty('helpKey');
    expect(field.type === 'select' && field.options[0]).toEqual({ label: 'Option A', value: 'a' });
  });

  it('surfaces the key when neither the catalog nor a literal exists', () => {
    const out = localizeSettingsSchema(
      { groups: [{ id: 'g', labelKey: 'missing.key', fields: [] as never[] }] },
      messages,
      'en-US',
      ['zh-CN'],
    ) as { groups: Array<{ label?: string }> };
    expect(out.groups[0]!.label).toBe('missing.key');
  });
});

/**
 * Guards the real shipped catalogs: a `labelKey` that is not in the package's
 * own catalog renders as the key name in the admin form, and neither the
 * literal scanner (a key is not a Chinese literal) nor the parity gate (both
 * locales can miss the same key) would catch it.
 */
describe('shipped theme catalogs cover their settings schema', () => {
  for (const id of ['default', 'stratus', 'aurora']) {
    it(`themes/${id}`, () => {
      const manifest = JSON.parse(
        readFileSync(`../../packages/themes/${id}/frontend/manifest.json`, 'utf8'),
      ) as { messages?: Record<string, Record<string, string>>; settingsSchema?: unknown };
      const { messages } = readPackageMessages(id, manifest.messages);
      const localized = localizeSettingsSchema(manifest.settingsSchema, messages, 'en-US', [
        'zh-CN',
      ]) as { groups: Array<{ label?: string; fields: Array<{ label?: string }> }> };
      expect(localized.groups.length).toBeGreaterThan(0);
      for (const group of localized.groups) {
        expect(group.label, 'group label').toBeTruthy();
        expect(group.label!.startsWith('settings.'), group.label).toBe(false);
        for (const field of group.fields) {
          expect(field.label, 'field label').toBeTruthy();
          expect(field.label!.startsWith('settings.'), field.label).toBe(false);
        }
      }
    });
  }
});
