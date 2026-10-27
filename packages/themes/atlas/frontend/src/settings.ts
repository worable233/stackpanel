import type { FrontendPackage, FrontendSettings } from '@stackpanel/sdk';
import zhCN from '../messages/zh-CN.json';

/**
 * Site copy is a settings default so the operator's value always wins. The
 * Chinese catalog value is only the seed.
 */
export const settingsSchema = {
  groups: [
    {
      id: 'hero',
      labelKey: 'settings.hero.group',
      fields: [
        {
          type: 'text',
          name: 'eyebrow',
          labelKey: 'settings.hero.eyebrow.label',
          default: zhCN['home.hero.kicker'],
        },
        {
          type: 'text',
          name: 'title1',
          labelKey: 'settings.hero.title1.label',
          default: zhCN['home.hero.title1'],
        },
        {
          type: 'text',
          name: 'title2',
          labelKey: 'settings.hero.title2.label',
          default: zhCN['home.hero.title2'],
        },
        {
          type: 'textarea',
          name: 'subtitle',
          labelKey: 'settings.hero.subtitle.label',
          default: zhCN['home.hero.subtitle'],
        },
        {
          type: 'text',
          name: 'primaryLabel',
          labelKey: 'settings.hero.primary.label',
          default: zhCN['home.hero.primary'],
        },
        {
          type: 'text',
          name: 'primaryHref',
          labelKey: 'settings.hero.primaryHref.label',
          default: '/shop',
        },
        {
          type: 'text',
          name: 'secondaryLabel',
          labelKey: 'settings.hero.secondary.label',
          default: zhCN['home.hero.secondary'],
        },
        {
          type: 'text',
          name: 'secondaryHref',
          labelKey: 'settings.hero.secondaryHref.label',
          default: '/about',
        },
        {
          type: 'text',
          name: 'asideTitle',
          labelKey: 'settings.hero.asideTitle.label',
          default: zhCN['home.hero.asideTitle'],
        },
        {
          type: 'textarea',
          name: 'asideText',
          labelKey: 'settings.hero.asideText.label',
          default: zhCN['home.hero.asideText'],
        },
      ],
    },
    {
      id: 'closing',
      labelKey: 'settings.closing.group',
      fields: [
        {
          type: 'text',
          name: 'title',
          labelKey: 'settings.closing.title.label',
          default: zhCN['home.cta.title'],
        },
        {
          type: 'textarea',
          name: 'text',
          labelKey: 'settings.closing.text.label',
          default: zhCN['home.cta.text'],
        },
        {
          type: 'text',
          name: 'primaryLabel',
          labelKey: 'settings.closing.primary.label',
          default: zhCN['home.cta.primary'],
        },
        {
          type: 'text',
          name: 'primaryHref',
          labelKey: 'settings.closing.primaryHref.label',
          default: '/shop',
        },
        {
          type: 'text',
          name: 'secondaryLabel',
          labelKey: 'settings.closing.secondary.label',
          default: zhCN['home.cta.secondary'],
        },
        {
          type: 'text',
          name: 'secondaryHref',
          labelKey: 'settings.closing.secondaryHref.label',
          default: '/guide',
        },
      ],
    },
    {
      id: 'social',
      labelKey: 'settings.social.group',
      fields: [
        {
          type: 'text',
          name: 'xHref',
          labelKey: 'settings.social.xHref.label',
          default: 'https://x.com/',
        },
        {
          type: 'text',
          name: 'githubHref',
          labelKey: 'settings.social.githubHref.label',
          default: 'https://github.com/worable233/stackpanel',
        },
        {
          type: 'text',
          name: 'contactHref',
          labelKey: 'settings.social.contactHref.label',
          default: '/about',
        },
      ],
    },
    {
      id: 'footer',
      labelKey: 'settings.footer.group',
      fields: [
        {
          type: 'textarea',
          name: 'tagline',
          labelKey: 'settings.footer.tagline.label',
          default: zhCN['layout.footerTagline'],
        },
      ],
    },
  ],
} satisfies NonNullable<FrontendPackage['settingsSchema']>;

/** `group.name` → zh-CN 种子值，用来识别「未被运营者改过」的默认值。 */
const SEED: Record<string, string> = Object.fromEntries(
  settingsSchema.groups.flatMap((group) =>
    group.fields
      .filter((field) => typeof field.default === 'string')
      .map((field) => [`${group.id}.${field.name}`, field.default as string]),
  ),
);

/** Only relative or http(s) links are rendered; anything else falls back. */
export function safeHref(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const href = value.trim();
  if (href.startsWith('https://') || href.startsWith('http://')) return href;
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  return fallback;
}

export function setting(
  settings: FrontendSettings | undefined,
  group: string,
  name: string,
  fallback?: string,
): string | undefined {
  const value = settings?.[group]?.[name];
  if (typeof value !== 'string' || !value.trim()) return fallback;
  // 运营者显式填过的值优先；但字段默认值只是 zh-CN 种子（settingsSchema 的
  // `default` 来自中文 catalog，因为设置面板需要一个可见的初值）。若原样返回
  // 种子，切到其它语言时这段文案会永远是简体中文——看起来就像「没适配」。
  // 因此「与种子完全相同」视为未自定义，改走当前语言的 `fallback`。
  if (value === SEED[`${group}.${name}`]) return fallback;
  return value;
}
