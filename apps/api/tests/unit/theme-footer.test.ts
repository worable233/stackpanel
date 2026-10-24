import { describe, expect, it } from 'vitest';
import {
  buildZodFromSettingsSchema,
  frontendSettingsSchema,
  frontendSettingsValueSchema,
  migrateFrontendSettings,
  settingsDefaultsFromSchema,
} from '@stackpanel/sdk';
import { settingsSchema } from '../../../../packages/themes/default/frontend/src/settings.js';
import { resolveFooter } from '../../../../packages/themes/default/frontend/src/footer-config.js';
import { resolveFrontendSettings } from '../../src/lib/frontend-settings.js';

const validate = buildZodFromSettingsSchema(settingsSchema);
describe('default theme configurable footer', () => {
  it('supports arbitrary categories and nested links through the manifest and stored-settings contracts', () => {
    expect(frontendSettingsSchema.safeParse(settingsSchema).success).toBe(true);
    const groups = Array.from({ length: 7 }, (_, index) => ({
      title: `Category ${index}`,
      links: [{ label: `Link ${index}`, href: `/custom/${index}` }],
    }));
    const settings = validate.parse({
      footer: {
        groups,
        socialLinks: [
          { label: 'Community', href: 'https://example.com/community', icon: 'discord' },
        ],
      },
    });
    expect(frontendSettingsValueSchema.parse(settings)).toEqual(settings);
    expect(resolveFrontendSettings(settingsSchema, settings)).toEqual(settings);
    expect(resolveFooter(settings).groups).toEqual(groups);
    expect(resolveFooter(settings).socialLinks[0]?.icon).toBe('discord');
  });
  it('preserves empty arrays so removed categories and icons do not reappear', () => {
    const settings = validate.parse({ footer: { groups: [], socialLinks: [] } });
    expect(resolveFooter(settings)).toEqual({ groups: [], socialLinks: [] });
  });
  it('migrates customized legacy columns and links without changing the input', () => {
    const legacy = {
      footer: {
        column1Title: 'Custom title',
        column1Links: [{ label: 'Docs', href: '/docs' }],
        column2Links: [],
        links: [{ label: 'Support', href: '/support' }],
      },
    };
    const original = structuredClone(legacy);
    const settings = resolveFrontendSettings(settingsSchema, legacy);
    expect(resolveFooter(settings).groups[0]).toEqual({
      title: 'Custom title',
      links: [{ label: 'Docs', href: '/docs' }],
    });
    expect(resolveFooter(settings).groups[1]?.links).toEqual([]);
    expect(resolveFooter(settings).socialLinks).toEqual([
      { label: 'Support', href: '/support', icon: 'link' },
    ]);
    expect(legacy).toEqual(original);
    expect(settings.footer).not.toHaveProperty('column1Title');
    expect(settings.footer).not.toHaveProperty('links');
  });
  it('gives explicit new configuration precedence over legacy settings and keeps migration idempotent', () => {
    const settings = {
      footer: {
        groups: [],
        socialLinks: [],
        column1Title: 'Old title',
        links: [{ label: 'Old', href: '/old' }],
      },
    };
    const upgraded = migrateFrontendSettings(settingsSchema, settings);
    expect(migrateFrontendSettings(settingsSchema, upgraded)).toEqual(upgraded);
    expect(resolveFooter(validate.parse(settings))).toEqual({ groups: [], socialLinks: [] });
  });
  it('validates nested field types and rejects unknown keys and icon choices', () => {
    expect(
      validate.safeParse({
        footer: { groups: [{ title: 'Docs', links: [{ label: 'Docs', href: 42 }] }] },
      }).success,
    ).toBe(false);
    expect(
      validate.safeParse({
        footer: {
          groups: [{ title: 'Docs', links: [{ label: 'Docs', href: '/docs', typo: true }] }],
        },
      }).success,
    ).toBe(false);
    expect(
      validate.safeParse({
        footer: { socialLinks: [{ label: 'Example', href: '/', icon: 'unknown-brand' }] },
      }).success,
    ).toBe(false);
    expect(validate.safeParse({ footer: 'not-an-object' }).success).toBe(false);
  });
  it('omits unsafe destinations and preserves order and duplicate titles', () => {
    const settings = validate.parse({
      footer: {
        groups: [
          {
            title: 'Same',
            links: [
              { label: 'Unsafe', href: 'javascript:alert(1)' },
              { label: 'Good', href: '/good' },
            ],
          },
          { title: 'Same', links: [{ label: 'Other', href: 'https://example.com' }] },
        ],
        socialLinks: [
          { label: 'Unsafe', href: '//evil.example', icon: 'x' },
          { label: 'Email', href: 'mailto:hello@example.com', icon: 'mail' },
        ],
      },
    });
    expect(resolveFooter(settings).groups.map((group) => group.links)).toEqual([
      [{ label: 'Good', href: '/good' }],
      [{ label: 'Other', href: 'https://example.com' }],
    ]);
    expect(resolveFooter(settings).socialLinks.map((item) => item.label)).toEqual(['Email']);
    expect(resolveFooter(settingsDefaultsFromSchema(settingsSchema)).groups).toHaveLength(4);
  });
});
