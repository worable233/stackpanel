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
      id: 'notice',
      labelKey: 'settings.notice.group',
      fields: [
        {
          type: 'text',
          name: 'label',
          labelKey: 'settings.notice.label.label',
          default: zhCN['home.notice.label'],
        },
        {
          type: 'text',
          name: 'text',
          labelKey: 'settings.notice.text.label',
          default: zhCN['home.notice.text'],
        },
        {
          type: 'text',
          name: 'href',
          labelKey: 'settings.notice.href.label',
          default: '/shop',
        },
      ],
    },
    {
      id: 'logos',
      labelKey: 'settings.logos.group',
      fields: [
        {
          type: 'text',
          name: 'label',
          labelKey: 'settings.logos.label.label',
          default: zhCN['home.logos.label'],
        },
        {
          type: 'list',
          name: 'items',
          labelKey: 'settings.logos.items.label',
          itemLabelField: 'name',
          fields: [
            {
              type: 'text',
              name: 'name',
              labelKey: 'settings.logos.items.name.label',
            },
          ],
        },
      ],
    },
    {
      id: 'products',
      labelKey: 'settings.products.group',
      fields: [
        {
          type: 'text',
          name: 'title',
          labelKey: 'settings.products.title.label',
          default: zhCN['home.products.title'],
        },
        {
          type: 'textarea',
          name: 'text',
          labelKey: 'settings.products.text.label',
          default: zhCN['home.products.text'],
        },
        {
          type: 'text',
          name: 'viewAll',
          labelKey: 'settings.products.viewAll.label',
          default: zhCN['home.products.viewAll'],
        },
      ],
    },
    {
      id: 'solutions',
      labelKey: 'settings.solutions.group',
      fields: [
        {
          type: 'text',
          name: 'title',
          labelKey: 'settings.solutions.title.label',
          default: zhCN['home.solutions.title'],
        },
        {
          type: 'textarea',
          name: 'text',
          labelKey: 'settings.solutions.text.label',
          default: zhCN['home.solutions.text'],
        },
        {
          type: 'text',
          name: 'cta',
          labelKey: 'settings.solutions.cta.label',
          default: zhCN['home.solutions.cta'],
        },
        {
          type: 'list',
          name: 'items',
          labelKey: 'settings.solutions.items.label',
          itemLabelField: 'title',
          fields: [
            { type: 'text', name: 'title', labelKey: 'settings.solutions.items.title.label' },
            { type: 'textarea', name: 'text', labelKey: 'settings.solutions.items.text.label' },
            { type: 'text', name: 'tag1', labelKey: 'settings.solutions.items.tag1.label' },
            { type: 'text', name: 'tag2', labelKey: 'settings.solutions.items.tag2.label' },
            { type: 'text', name: 'metric', labelKey: 'settings.solutions.items.metric.label' },
            {
              type: 'text',
              name: 'metricLabel',
              labelKey: 'settings.solutions.items.metricLabel.label',
            },
          ],
        },
      ],
    },
    {
      id: 'cases',
      labelKey: 'settings.cases.group',
      fields: [
        {
          type: 'text',
          name: 'title',
          labelKey: 'settings.cases.title.label',
          default: zhCN['home.cases.title'],
        },
        {
          type: 'textarea',
          name: 'text',
          labelKey: 'settings.cases.text.label',
          default: zhCN['home.cases.text'],
        },
        {
          type: 'list',
          name: 'items',
          labelKey: 'settings.cases.items.label',
          itemLabelField: 'person',
          fields: [
            { type: 'textarea', name: 'quote', labelKey: 'settings.cases.items.quote.label' },
            { type: 'text', name: 'person', labelKey: 'settings.cases.items.person.label' },
            { type: 'text', name: 'metric1', labelKey: 'settings.cases.items.metric1.label' },
            {
              type: 'text',
              name: 'metric1Label',
              labelKey: 'settings.cases.items.metric1Label.label',
            },
            { type: 'text', name: 'metric2', labelKey: 'settings.cases.items.metric2.label' },
            {
              type: 'text',
              name: 'metric2Label',
              labelKey: 'settings.cases.items.metric2Label.label',
            },
          ],
        },
      ],
    },
    {
      id: 'infrastructure',
      labelKey: 'settings.infrastructure.group',
      fields: [
        {
          type: 'text',
          name: 'title',
          labelKey: 'settings.infrastructure.title.label',
          default: zhCN['home.infra.title'],
        },
        {
          type: 'textarea',
          name: 'text',
          labelKey: 'settings.infrastructure.text.label',
          default: zhCN['home.infra.text'],
        },
        {
          type: 'text',
          name: 'regionsValue',
          labelKey: 'settings.infrastructure.regionsValue.label',
          default: '8',
        },
        {
          type: 'text',
          name: 'regionsLabel',
          labelKey: 'settings.infrastructure.regionsLabel.label',
          default: zhCN['home.infra.regionsLabel'],
        },
        {
          type: 'text',
          name: 'azsValue',
          labelKey: 'settings.infrastructure.azsValue.label',
          default: '24',
        },
        {
          type: 'text',
          name: 'azsLabel',
          labelKey: 'settings.infrastructure.azsLabel.label',
          default: zhCN['home.infra.azsLabel'],
        },
        {
          type: 'text',
          name: 'nodesValue',
          labelKey: 'settings.infrastructure.nodesValue.label',
          default: '2800',
        },
        {
          type: 'text',
          name: 'nodesLabel',
          labelKey: 'settings.infrastructure.nodesLabel.label',
          default: zhCN['home.infra.nodesLabel'],
        },
        {
          type: 'text',
          name: 'slaValue',
          labelKey: 'settings.infrastructure.slaValue.label',
          default: '99.99',
        },
        {
          type: 'text',
          name: 'slaLabel',
          labelKey: 'settings.infrastructure.slaLabel.label',
          default: zhCN['home.infra.slaLabel'],
        },
        {
          type: 'list',
          name: 'regions',
          labelKey: 'settings.infrastructure.regions.label',
          itemLabelField: 'name',
          fields: [
            {
              type: 'text',
              name: 'name',
              labelKey: 'settings.infrastructure.regions.name.label',
            },
          ],
        },
      ],
    },
    {
      id: 'faq',
      labelKey: 'settings.faq.group',
      fields: [
        {
          type: 'text',
          name: 'title',
          labelKey: 'settings.faq.title.label',
          default: zhCN['home.faq.title'],
        },
        {
          type: 'textarea',
          name: 'text',
          labelKey: 'settings.faq.text.label',
          default: zhCN['home.faq.text'],
        },
        {
          type: 'text',
          name: 'contact',
          labelKey: 'settings.faq.contact.label',
          default: zhCN['home.faq.contact'],
        },
        {
          type: 'list',
          name: 'items',
          labelKey: 'settings.faq.items.label',
          itemLabelField: 'q',
          fields: [
            { type: 'text', name: 'q', labelKey: 'settings.faq.items.q.label' },
            { type: 'textarea', name: 'a', labelKey: 'settings.faq.items.a.label' },
          ],
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

export function numberSetting(
  settings: FrontendSettings | undefined,
  group: string,
  name: string,
  fallback: number,
): number {
  const value = settings?.[group]?.[name];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Structured list values; empty means "use the localized catalog fallback". */
export function listSetting(
  settings: FrontendSettings | undefined,
  group: string,
  name: string,
): Array<Record<string, unknown>> {
  const value = settings?.[group]?.[name];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? [item as Record<string, unknown>]
      : [],
  );
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
