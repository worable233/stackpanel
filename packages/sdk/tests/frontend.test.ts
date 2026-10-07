import { describe, expect, it } from 'vitest';
import {
  buildZodFromSettingsSchema,
  captureFrontendPathParams,
  matchFrontendPagePath,
  mergeFrontendSettings,
  resolveFrontendPageSource,
  resolveThemeOverride,
  selectFrontendPageDefinition,
  settingsDefaultsFromSchema,
} from '../src/frontend.js';
import type { FrontendPageDefinition, FrontendSettingsSchema } from '../src/frontend.js';

const schema: FrontendSettingsSchema = {
  groups: [
    {
      id: 'layout',
      label: 'Layout',
      fields: [
        {
          type: 'select',
          name: 'nav',
          label: 'Navigation',
          default: 'single',
          options: [
            { label: 'Single', value: 'single' },
            { label: 'Double', value: 'double' },
          ],
        },
        {
          type: 'number',
          name: 'perPage',
          label: 'Per page',
          default: 12,
          min: 1,
          max: 60,
        },
      ],
    },
    {
      id: 'appearance',
      label: 'Appearance',
      fields: [{ type: 'color', name: 'accent', label: 'Accent', default: '#2563eb' }],
    },
  ],
};

describe('frontend settings schema', () => {
  it('produces schema defaults', () => {
    expect(settingsDefaultsFromSchema(schema)).toEqual({
      layout: { nav: 'single', perPage: 12 },
      appearance: { accent: '#2563eb' },
    });
  });

  it('builds a zod validator that accepts defaults', () => {
    const zod = buildZodFromSettingsSchema(schema);
    expect(zod.safeParse({}).success).toBe(true);
    expect(zod.parse({})).toEqual({
      layout: { nav: 'single', perPage: 12 },
      appearance: { accent: '#2563eb' },
    });
  });

  it('rejects invalid values', () => {
    const zod = buildZodFromSettingsSchema(schema);
    expect(
      zod.safeParse({
        layout: { nav: 'triple', perPage: 0 },
        appearance: { accent: '#fff' },
      }).success,
    ).toBe(false);
  });

  it('merges partial persisted values over defaults', () => {
    const merged = mergeFrontendSettings(settingsDefaultsFromSchema(schema), {
      layout: { nav: 'double' },
    });
    expect(merged.layout).toEqual({ nav: 'double', perPage: 12 });
  });
});

describe('frontend settings list field', () => {
  const listSchema: FrontendSettingsSchema = {
    groups: [
      {
        id: 'regions',
        label: '服务区域',
        fields: [
          {
            type: 'list',
            name: 'items',
            label: '机房',
            itemLabelField: 'city',
            fields: [
              { type: 'text', name: 'city', label: '城市' },
              { type: 'number', name: 'lat', label: '纬度', default: 0, step: 0.0001 },
            ],
            default: [{ city: '上海', lat: 31.23 }],
          },
        ],
      },
    ],
  };

  it('produces list defaults', () => {
    expect(settingsDefaultsFromSchema(listSchema)).toEqual({
      regions: { items: [{ city: '上海', lat: 31.23 }] },
    });
  });

  it('validates rows and rejects unknown scalar types', () => {
    const zod = buildZodFromSettingsSchema(listSchema);
    expect(zod.parse({}).regions?.items).toEqual([{ city: '上海', lat: 31.23 }]);
    expect(
      zod.safeParse({ regions: { items: [{ city: '北京', lat: 39.9 }] } }).success,
    ).toBe(true);
    expect(zod.safeParse({ regions: { items: [{ city: '北京', lat: 'x' }] } }).success).toBe(
      false,
    );
  });

  it('defaults a missing list to an empty array', () => {
    const noDefault: FrontendSettingsSchema = {
      groups: [
        {
          id: 'regions',
          label: '服务区域',
          fields: [
            {
              type: 'list',
              name: 'items',
              label: '机房',
              fields: [{ type: 'text', name: 'city', label: '城市' }],
            },
          ],
        },
      ],
    };
    expect(buildZodFromSettingsSchema(noDefault).parse({}).regions?.items).toEqual([]);
  });
});

describe('frontend page priority', () => {
  const themePages: FrontendPageDefinition[] = [
    { path: '/', component: 'home' },
    { path: '/shop', component: 'shop' },
  ];
  const pluginPages: FrontendPageDefinition[] = [{ path: '/shop/:id', component: 'product' }];

  it('prefers the theme page when both theme and plugin define a path', () => {
    expect(resolveFrontendPageSource(themePages, pluginPages, '/shop')).toBe('theme');
  });

  it('falls back to a plugin page when the theme lacks the path', () => {
    expect(resolveFrontendPageSource(themePages, pluginPages, '/shop/demo-com')).toBe('plugin');
  });

  it('matches dynamic path segments', () => {
    expect(matchFrontendPagePath('/shop/:id', '/shop/demo-com')).toBe(true);
    expect(matchFrontendPagePath('/shop/:id', '/shop/demo-com/extra')).toBe(false);
  });

  it('matches arbitrary theme routes and captures params', () => {
    expect(matchFrontendPagePath('/blog/:slug', '/blog/theme-system')).toBe(true);
    expect(matchFrontendPagePath('/blog/*', '/blog/theme-system')).toBe(true);
    expect(matchFrontendPagePath('*', '/any/unknown/path')).toBe(true);
    expect(captureFrontendPathParams('/blog/:slug', '/blog/theme-system')).toEqual({
      slug: 'theme-system',
    });
    expect(captureFrontendPathParams('/blog/*', '/blog/theme-system/extra')).toEqual({
      '*': 'theme-system/extra',
    });
  });

  it('lets a concrete page win over an earlier parameter page in one package', () => {
    const pages: FrontendPageDefinition[] = [
      { path: '/content/:id', component: 'detail' },
      { path: '/content/new', component: 'create' },
    ];
    expect(selectFrontendPageDefinition(pages, '/content/new')?.component).toBe('create');
  });

  it('treats * as a fallback instead of overriding plugin pages', () => {
    const themeWithFallback: FrontendPageDefinition[] = [
      { path: '/', component: 'home' },
      { path: '*', component: 'notFound' },
    ];
    const pluginPages: FrontendPageDefinition[] = [{ path: '/about', component: 'about' }];
    expect(resolveFrontendPageSource(themeWithFallback, pluginPages, '/about')).toBe('plugin');
    expect(resolveFrontendPageSource(themeWithFallback, pluginPages, '/missing')).toBe('theme');
  });
});

describe('theme page overrides', () => {
  it('resolves an exact override path', () => {
    expect(resolveThemeOverride({ '/shop': 'shop' }, '/shop')).toBe('shop');
  });

  it('resolves a parameterized override pattern', () => {
    expect(resolveThemeOverride({ '/shop/:id': 'shopDetail' }, '/shop/demo-com')).toBe(
      'shopDetail',
    );
  });

  it('prefers the most concrete pattern when several match', () => {
    const overrides = { '/shop/*': 'generic', '/shop/:id': 'detail' };
    expect(resolveThemeOverride(overrides, '/shop/demo-com')).toBe('detail');
  });

  it('returns undefined when no override matches', () => {
    expect(resolveThemeOverride({ '/shop': 'shop' }, '/account')).toBeUndefined();
    expect(resolveThemeOverride(undefined, '/shop')).toBeUndefined();
  });
});
