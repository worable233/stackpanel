import { formatMinorCurrency } from '@stackpanel/sdk';
import type { FrontendPageProps } from '@stackpanel/sdk';
import {
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionRoot,
  AccordionTrigger,
  Badge,
  Button,
  CountingNumber,
  Fade,
  Magnetic,
  MotionGrid,
  MotionGridCells,
  ShimmeringText,
  Slide,
  SplittingText,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTab,
  Tilt,
  TiltContent,
} from '@stackpanel/ui';
import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  Database,
  Globe2,
  HardDrive,
  Network,
  Plus,
  Quote,
  Server,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { t } from './i18n.js';
import { MOTION_CSS } from './motion-styles.js';
import { listSetting, numberSetting, safeHref, setting } from './settings.js';

const INTL_FALLBACK_LOCALE = 'en';

interface ShopProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number;
  status: string;
  categoryId?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface ShopCategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  sortOrder: number;
  productCount: number;
  children: ShopCategoryNode[];
}

function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function rowText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function money(amount: number, currency: string, locale?: string): string {
  try {
    return formatMinorCurrency(amount, currency, locale ?? INTL_FALLBACK_LOCALE);
  } catch {
    return `${amount} ${currency}`;
  }
}

function readProducts(data: FrontendPageProps['data']): ShopProduct[] {
  const raw = data.products as ShopProduct[] | { products?: ShopProduct[] } | undefined;
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.products)) return raw.products;
  return [];
}

function readCategories(data: FrontendPageProps['data']): ShopCategoryNode[] {
  const raw = data.storeCategories as
    ShopCategoryNode[] | { categories?: ShopCategoryNode[] } | undefined;
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.categories)) return raw.categories;
  return [];
}

function categoryLabel(slug: string | null, fallback: string, tr: ReturnType<typeof t>): string {
  const known: Record<string, string> = {
    network: tr('home.categories.network'),
    compute: tr('home.categories.compute'),
    storage: tr('home.categories.storage'),
    domain: tr('home.categories.domain'),
    'web-hosting': tr('home.categories.hosting'),
    'object-storage': tr('home.categories.objectStorage'),
    'cloud-server': tr('home.categories.cloudServer'),
    cdn: tr('home.categories.cdn'),
  };
  return (slug && known[slug]) || fallback;
}

function ProductIcon({ name }: { name: string }): ReactElement {
  const lower = name.toLowerCase();
  if (
    lower.includes('network') ||
    lower.includes('加速') /* i18n-exempt — product name keyword */ ||
    lower.includes('cdn')
  ) {
    return <Network className="size-5" aria-hidden="true" />;
  }
  if (
    lower.includes('storage') ||
    lower.includes('volume') ||
    lower.includes('对象') /* i18n-exempt — product name keyword */
  ) {
    return <HardDrive className="size-5" aria-hidden="true" />;
  }
  if (
    lower.includes('postgres') ||
    lower.includes('database') ||
    lower.includes('数据') /* i18n-exempt — product name keyword */
  ) {
    return <Database className="size-5" aria-hidden="true" />;
  }
  if (
    lower.includes('inference') ||
    lower.includes('model') ||
    lower.includes('推理') /* i18n-exempt — product name keyword */
  ) {
    return <Sparkles className="size-5" aria-hidden="true" />;
  }
  if (lower.includes('domain') || lower.includes('域名') /* i18n-exempt — product name keyword */) {
    return <Globe2 className="size-5" aria-hidden="true" />;
  }
  return <Server className="size-5" aria-hidden="true" />;
}

/* A slow diagonal wave, rendered by Animate UI's MotionGrid. */
const HERO_GRID_FRAMES: Array<Array<[number, number]>> = Array.from({ length: 16 }, (_, frame) => {
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < 11; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      const distance = (x + y * 3 - frame * 1.5 + 80) % 18;
      if (distance < 2.8) cells.push([x, y]);
    }
  }
  return cells;
});

const REGION_DOTS = new Set([8, 14, 21, 33, 38, 46, 52, 61, 67, 74, 79, 86]);

function ProductCard({
  product,
  locale,
  tr,
}: {
  product: ShopProduct;
  locale: string | undefined;
  tr: ReturnType<typeof t>;
}): ReactElement {
  return (
    <Tilt maxTilt={4} perspective={1000} className="h-full">
      <TiltContent className="h-full">
        <article className="group flex h-full flex-col rounded-[24px] bg-background p-6 transition-colors duration-300 hover:bg-muted/50">
          <div className="flex items-center justify-between">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-muted text-foreground transition-colors group-hover:bg-foreground group-hover:text-background">
              <ProductIcon name={product.name} />
            </span>
            <Badge
              variant={product.stock > 0 ? 'secondary' : 'destructive'}
              className="gap-1.5 px-2 py-1"
            >
              <Boxes className="size-3" aria-hidden="true" />
              {product.stock > 0
                ? tr('home.products.stock', { count: String(product.stock) })
                : tr('home.products.outOfStock')}
            </Badge>
          </div>

          <h3 className="mt-7 text-lg font-medium tracking-tight">
            <a href="/register" className="after:absolute after:inset-0">
              {product.name}
            </a>
          </h3>
          <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-6 text-muted-foreground">
            {product.description ?? tr('product.fallbackDescription')}
          </p>

          <div className="mt-auto flex items-end justify-between gap-4 pt-8">
            <div>
              <p className="text-[11px] text-muted-foreground">{tr('home.products.from')}</p>
              <p className="mt-0.5 text-xl font-medium tracking-tight tabular-nums">
                {money(product.price, product.currency, locale)}
              </p>
            </div>
            <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground transition-colors group-hover:bg-foreground group-hover:text-background">
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </span>
          </div>
        </article>
      </TiltContent>
    </Tilt>
  );
}

function ProductShowcase({
  products,
  categories,
  locale,
  settings,
}: {
  products: ShopProduct[];
  categories: ShopCategoryNode[];
  locale: string | undefined;
  settings: FrontendPageProps['settings'];
}): ReactElement {
  const tr = t(locale);
  const tabs = [
    { id: 'all', label: tr('home.products.all') },
    ...categories
      .filter((category) => products.some((product) => product.categoryId === category.id))
      .slice(0, 3)
      .map((category) => ({
        id: category.id,
        label: categoryLabel(category.slug, category.name, tr),
      })),
  ];

  const panelProducts = (id: string): ShopProduct[] => {
    const list = id === 'all' ? products : products.filter((product) => product.categoryId === id);
    return list.slice(0, 6);
  };

  return (
    <section className="bg-muted py-20 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <Fade className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <h2 className="max-w-xl text-3xl font-medium tracking-tight text-balance sm:text-4xl">
              {setting(settings, 'products', 'title', tr('home.products.title'))}
            </h2>
            <p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">
              {setting(settings, 'products', 'text', tr('home.products.text'))}
            </p>
          </div>
          <a
            href="/shop"
            className="group inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {setting(settings, 'products', 'viewAll', tr('home.products.viewAll'))}
            <ArrowRight
              className="size-4 transition-transform group-hover:translate-x-1"
              aria-hidden="true"
            />
          </a>
        </Fade>

        <TabsRoot defaultValue={tabs[0]?.id ?? 'all'} className="mt-10">
          <TabsList className="flex flex-wrap items-center gap-2 bg-transparent p-0">
            {tabs.map((tab) => (
              <TabsTab
                key={tab.id}
                value={tab.id}
                className="rounded-full bg-background px-4 py-2 text-sm font-medium text-muted-foreground transition-colors data-[active]:bg-foreground data-[active]:text-background"
              >
                {tab.label}
              </TabsTab>
            ))}
          </TabsList>

          {tabs.map((tab) => (
            <TabsPanel key={tab.id} value={tab.id} className="mt-8">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {panelProducts(tab.id).map((product, index) => (
                  <Slide key={product.id} delay={index * 70} className="h-full">
                    <ProductCard product={product} locale={locale} tr={tr} />
                  </Slide>
                ))}
              </div>
              {panelProducts(tab.id).length === 0 ? (
                <p className="rounded-2xl bg-background px-6 py-10 text-sm text-muted-foreground">
                  {tr('home.products.empty')}
                </p>
              ) : null}
            </TabsPanel>
          ))}
        </TabsRoot>
      </div>
    </section>
  );
}

const SOLUTIONS = [
  {
    key: 'commerce',
    icon: Boxes,
    metric: '2.4x',
  },
  {
    key: 'ai',
    icon: Sparkles,
    metric: '38%',
  },
  {
    key: 'media',
    icon: Zap,
    metric: '<30ms',
  },
] as const;

function SolutionsSection({
  locale,
  settings,
}: {
  locale: string | undefined;
  settings: FrontendPageProps['settings'];
}): ReactElement {
  const tr = t(locale);
  const configured = listSetting(settings, 'solutions', 'items');
  const cards =
    configured.length > 0
      ? configured.map((item, index) => ({
          key: `custom-${index}`,
          icon: SOLUTIONS[index % SOLUTIONS.length]!.icon,
          metric: rowText(item, 'metric'),
          title: rowText(item, 'title'),
          text: rowText(item, 'text'),
          tag1: rowText(item, 'tag1'),
          tag2: rowText(item, 'tag2'),
          metricLabel: rowText(item, 'metricLabel'),
        }))
      : SOLUTIONS.map((solution) => ({
          key: solution.key,
          icon: solution.icon,
          metric: solution.metric,
          title: tr(`home.solutions.${solution.key}.title`),
          text: tr(`home.solutions.${solution.key}.text`),
          tag1: tr(`home.solutions.${solution.key}.tag1`),
          tag2: tr(`home.solutions.${solution.key}.tag2`),
          metricLabel: tr(`home.solutions.${solution.key}.metricLabel`),
        }));
  return (
    <section className="bg-background py-20 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <Fade className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <h2 className="max-w-2xl text-3xl font-medium tracking-tight text-balance sm:text-4xl">
              {setting(settings, 'solutions', 'title', tr('home.solutions.title'))}
            </h2>
          </div>
          <p className="max-w-sm text-sm leading-6 text-muted-foreground">
            {setting(settings, 'solutions', 'text', tr('home.solutions.text'))}
          </p>
        </Fade>

        <div className="mt-10 grid gap-4 lg:grid-cols-3">
          {cards.map((card, index) => {
            const Icon = card.icon;
            return (
              <Slide key={card.key} delay={index * 90} className="h-full">
                <Tilt maxTilt={3} perspective={1100} className="h-full">
                  <TiltContent className="h-full">
                    <article className="group flex h-full flex-col rounded-[28px] bg-muted/80 p-7 transition-colors duration-300 hover:bg-muted">
                      <div className="flex items-start justify-between">
                        <span className="flex size-11 items-center justify-center rounded-2xl bg-background text-foreground">
                          <Icon className="size-5" aria-hidden="true" />
                        </span>
                        <span className="text-3xl font-medium tracking-tight text-muted-foreground/45 tabular-nums">
                          {card.metric}
                        </span>
                      </div>

                      <h3 className="mt-12 text-xl font-medium tracking-tight">{card.title}</h3>
                      <p className="mt-3 text-sm leading-6 text-muted-foreground">{card.text}</p>

                      <div className="mt-6 flex flex-wrap gap-2">
                        {[card.tag1, card.tag2].filter(Boolean).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-background px-3 py-1 text-[11px] text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>

                      <div className="mt-auto flex items-center gap-2 pt-10 text-xs text-muted-foreground">
                        <Check className="size-3.5" aria-hidden="true" />
                        {card.metricLabel}
                      </div>
                    </article>
                  </TiltContent>
                </Tilt>
              </Slide>
            );
          })}
        </div>

        <Fade className="mt-8">
          <a
            href="/about"
            className="group inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {setting(settings, 'solutions', 'cta', tr('home.solutions.cta'))}
            <ArrowUpRight
              className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </a>
        </Fade>
      </div>
    </section>
  );
}

function CasesSection({
  locale,
  settings,
}: {
  locale: string | undefined;
  settings: FrontendPageProps['settings'];
}): ReactElement {
  const tr = t(locale);
  const configured = listSetting(settings, 'cases', 'items');
  const cases =
    configured.length > 0
      ? configured.map((item, index) => ({
          key: `custom-${index}`,
          quote: rowText(item, 'quote'),
          person: rowText(item, 'person'),
          metric1: rowText(item, 'metric1'),
          metric1Label: rowText(item, 'metric1Label'),
          metric2: rowText(item, 'metric2'),
          metric2Label: rowText(item, 'metric2Label'),
        }))
      : [1, 2].map((index) => ({
          key: String(index),
          quote: tr(`home.cases.${index}.quote`),
          person: tr(`home.cases.${index}.person`),
          metric1: tr(`home.cases.${index}.metric1`),
          metric1Label: tr(`home.cases.${index}.metric1Label`),
          metric2: tr(`home.cases.${index}.metric2`),
          metric2Label: tr(`home.cases.${index}.metric2Label`),
        }));

  return (
    <section className="bg-muted py-20 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <Fade>
          <h2 className="max-w-2xl text-3xl font-medium tracking-tight text-balance sm:text-4xl">
            {setting(settings, 'cases', 'title', tr('home.cases.title'))}
          </h2>
          <p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">
            {setting(settings, 'cases', 'text', tr('home.cases.text'))}
          </p>
        </Fade>

        <div className="mt-10 grid gap-4 lg:grid-cols-2">
          {cases.map((item, index) => (
            <Slide key={item.key} delay={index * 80} className="h-full">
              <article className="flex h-full flex-col rounded-[28px] bg-background p-7 sm:p-9">
                <Quote className="size-7 text-muted-foreground/50" aria-hidden="true" />
                <blockquote className="mt-8 text-xl leading-8 font-medium tracking-tight text-balance sm:text-2xl sm:leading-9">
                  {item.quote}
                </blockquote>
                <p className="mt-5 text-xs text-muted-foreground">{item.person}</p>

                <div className="mt-10 grid grid-cols-2 gap-4">
                  {[
                    { value: item.metric1, label: item.metric1Label },
                    { value: item.metric2, label: item.metric2Label },
                  ].map((metric) => (
                    <div key={metric.label} className="rounded-2xl bg-muted/60 px-5 py-4">
                      <p className="text-2xl font-medium tracking-tight tabular-nums">
                        {metric.value}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">{metric.label}</p>
                    </div>
                  ))}
                </div>
              </article>
            </Slide>
          ))}
        </div>
      </div>
    </section>
  );
}

function InfrastructureSection({
  locale,
  settings,
}: {
  locale: string | undefined;
  settings: FrontendPageProps['settings'];
}): ReactElement {
  const tr = t(locale);
  const stats = [
    {
      value: numberSetting(settings, 'infrastructure', 'regionsValue', 8),
      decimals: 0,
      suffix: '',
      label: setting(settings, 'infrastructure', 'regionsLabel', tr('home.infra.regionsLabel')),
    },
    {
      value: numberSetting(settings, 'infrastructure', 'azsValue', 24),
      decimals: 0,
      suffix: '',
      label: setting(settings, 'infrastructure', 'azsLabel', tr('home.infra.azsLabel')),
    },
    {
      value: numberSetting(settings, 'infrastructure', 'nodesValue', 2800),
      decimals: 0,
      suffix: '+',
      label: setting(settings, 'infrastructure', 'nodesLabel', tr('home.infra.nodesLabel')),
    },
    {
      value: numberSetting(settings, 'infrastructure', 'slaValue', 99.99),
      decimals: 2,
      suffix: '%',
      label: setting(settings, 'infrastructure', 'slaLabel', tr('home.infra.slaLabel')),
    },
  ];
  const configuredRegions = listSetting(settings, 'infrastructure', 'regions')
    .map((item) => rowText(item, 'name'))
    .filter(Boolean);
  const regions =
    configuredRegions.length > 0
      ? configuredRegions
      : [1, 2, 3, 4, 5, 6].map((region) => tr(`home.infra.region.${region}`));

  return (
    <section className="bg-background py-20 sm:py-24">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-20">
          <Fade>
            <h2 className="max-w-md text-3xl font-medium tracking-tight text-balance sm:text-4xl">
              {setting(settings, 'infrastructure', 'title', tr('home.infra.title'))}
            </h2>
            <p className="mt-4 max-w-md text-sm leading-6 text-muted-foreground">
              {setting(settings, 'infrastructure', 'text', tr('home.infra.text'))}
            </p>

            <div className="mt-10 grid grid-cols-2 gap-x-6 gap-y-8">
              {stats.map((stat) => (
                <div key={stat.label}>
                  <p className="text-3xl font-medium tracking-tight tabular-nums sm:text-4xl">
                    <CountingNumber
                      number={stat.value}
                      decimalPlaces={stat.decimals}
                      thousandSeparator=","
                    />
                    <span className="text-xl text-muted-foreground">{stat.suffix}</span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{stat.label}</p>
                </div>
              ))}
            </div>
          </Fade>

          <Slide direction="left">
            <div className="relative aspect-[5/4] overflow-hidden rounded-[32px] bg-muted/80 p-7 sm:p-9">
              <div className="grid h-full grid-cols-10 grid-rows-8 gap-2">
                {Array.from({ length: 80 }, (_, index) => (
                  <span
                    key={index}
                    className={cn(
                      'self-center justify-self-center rounded-full transition-colors',
                      REGION_DOTS.has(index) ? 'size-2 bg-foreground' : 'size-1.5 bg-foreground/15',
                    )}
                    aria-hidden="true"
                  />
                ))}
              </div>

              <div className="pointer-events-none absolute inset-x-7 bottom-7 flex flex-wrap items-end justify-between gap-4 sm:inset-x-9 sm:bottom-9">
                <div className="flex flex-wrap gap-2">
                  {regions.map((region) => (
                    <span
                      key={region}
                      className="rounded-full bg-background px-3 py-1 text-[10px] font-medium text-muted-foreground"
                    >
                      {region}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </Slide>
        </div>
      </div>
    </section>
  );
}

const FAQS = ['1', '2', '3', '4'] as const;

function FaqSection({
  locale,
  settings,
}: {
  locale: string | undefined;
  settings: FrontendPageProps['settings'];
}): ReactElement {
  const tr = t(locale);
  const configured = listSetting(settings, 'faq', 'items');
  const faqs =
    configured.length > 0
      ? configured.map((item, index) => ({
          key: `custom-${index}`,
          q: rowText(item, 'q'),
          a: rowText(item, 'a'),
        }))
      : FAQS.map((index) => ({
          key: index,
          q: tr(`home.faq.${index}.q`),
          a: tr(`home.faq.${index}.a`),
        }));

  return (
    <section className="bg-background pb-24">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[0.75fr_1.25fr] lg:gap-20">
          <Fade>
            <h2 className="max-w-sm text-3xl font-medium tracking-tight text-balance sm:text-4xl">
              {setting(settings, 'faq', 'title', tr('home.faq.title'))}
            </h2>
            <p className="mt-4 max-w-xs text-sm leading-6 text-muted-foreground">
              {setting(settings, 'faq', 'text', tr('home.faq.text'))}
            </p>
            <a
              href="/about"
              className="mt-8 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {setting(settings, 'faq', 'contact', tr('home.faq.contact'))}
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </a>
          </Fade>

          <AccordionRoot defaultValue={['faq-0']} className="flex flex-col gap-3">
            {faqs.map((item, index) => (
              <AccordionItem
                key={item.key}
                value={`faq-${index}`}
                className="rounded-[20px] bg-muted/80 px-5 transition-colors data-[open]:bg-muted sm:px-6"
              >
                <AccordionHeader>
                  <AccordionTrigger className="group flex w-full items-center justify-between gap-4 py-5 text-left text-sm font-medium">
                    {item.q}
                    <Plus
                      className="size-4 shrink-0 text-muted-foreground transition-transform duration-300 group-data-[panel-open]:rotate-45"
                      aria-hidden="true"
                    />
                  </AccordionTrigger>
                </AccordionHeader>
                <AccordionPanel className="pb-5 pr-8 text-sm leading-6 text-muted-foreground">
                  {item.a}
                </AccordionPanel>
              </AccordionItem>
            ))}
          </AccordionRoot>
        </div>
      </div>
    </section>
  );
}

function LogoWall({
  locale,
  settings,
}: {
  locale: string | undefined;
  settings: FrontendPageProps['settings'];
}): ReactElement {
  const tr = t(locale);
  const configured = listSetting(settings, 'logos', 'items')
    .map((item) => rowText(item, 'name'))
    .filter(Boolean);
  const logos =
    configured.length > 0
      ? configured
      : [
          'OpenAI',
          'Anthropic',
          'Google',
          'AWS',
          'Azure',
          'Cloudflare',
          'Alibaba',
          'DeepSeek',
          'vLLM',
          'Ollama',
        ];
  return (
    <section className="bg-background">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <p className="text-center text-[10px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
          {setting(settings, 'logos', 'label', tr('home.logos.label'))}
        </p>
        <div className="atl-ticker-mask mt-7 overflow-hidden">
          <div className="atl-ticker">
            {[0, 1].map((copy) => (
              <div
                key={copy}
                className="flex shrink-0 items-center gap-10 pr-10 sm:gap-14 sm:pr-14"
                aria-hidden={copy === 1}
              >
                {logos.map((logo) => (
                  <span
                    key={logo}
                    className="shrink-0 text-lg font-medium tracking-tight whitespace-nowrap text-muted-foreground/60"
                  >
                    {logo}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function AtlasHomePage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const primaryHref = safeHref(setting(props.settings, 'hero', 'primaryHref', '/shop'), '/shop');
  const secondaryHref = safeHref(
    setting(props.settings, 'hero', 'secondaryHref', '/guide'),
    '/guide',
  );
  const closingPrimaryHref = safeHref(
    setting(props.settings, 'closing', 'primaryHref', '/shop'),
    '/shop',
  );
  const closingSecondaryHref = safeHref(
    setting(props.settings, 'closing', 'secondaryHref', '/guide'),
    '/guide',
  );
  const noticeHref = safeHref(setting(props.settings, 'notice', 'href', '/shop'), '/shop');
  const products = readProducts(props.data);
  const categories = readCategories(props.data);

  return (
    <main className="flex-1 overflow-hidden">
      <style dangerouslySetInnerHTML={{ __html: MOTION_CSS }} />
      <section className="relative overflow-hidden bg-background">
        <MotionGrid
          gridSize={[24, 11]}
          frames={HERO_GRID_FRAMES}
          duration={820}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-70 [mask-image:radial-gradient(ellipse_at_center,black,transparent_74%)]"
        >
          <MotionGridCells
            activeProps={{
              className: 'bg-[radial-gradient(circle,rgba(0,0,0,0.26)_2px,transparent_2px)]',
            }}
            inactiveProps={{ className: 'bg-transparent' }}
          />
        </MotionGrid>

        <div className="relative mx-auto w-full max-w-6xl px-4 pb-16 pt-16 text-center sm:px-6 lg:pb-24 lg:pt-24">
          <Fade>
            <a
              href={noticeHref}
              className="group inline-flex max-w-full items-center gap-3 rounded-full bg-muted/80 py-1.5 pl-2 pr-4 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              <span className="inline-flex items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-[10px] font-medium tracking-[0.12em] text-foreground uppercase">
                <span className="atl-blink size-1.5 rounded-full bg-success" aria-hidden="true" />
                {setting(props.settings, 'notice', 'label', tr('home.notice.label'))}
              </span>
              <span className="truncate">
                <ShimmeringText
                  text={setting(props.settings, 'notice', 'text', tr('home.notice.text')) ?? ''}
                  className="font-medium text-foreground"
                />
              </span>
              <ArrowRight
                className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </a>
          </Fade>

          <h1 className="mx-auto mt-8 max-w-4xl text-[2.6rem] leading-[1.08] font-medium tracking-[-0.04em] text-balance sm:text-6xl lg:text-7xl">
            <SplittingText
              text={
                setting(props.settings, 'hero', 'title1', tr('home.hero.title1')) ??
                tr('home.hero.title1')
              }
              type="chars"
              initial={{ y: '0.35em', opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              stagger={0.018}
              inView
              inViewOnce
              className="block"
            />
            <SplittingText
              text={
                setting(props.settings, 'hero', 'title2', tr('home.hero.title2')) ??
                tr('home.hero.title2')
              }
              type="chars"
              initial={{ y: '0.35em', opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              stagger={0.018}
              delay={160}
              inView
              inViewOnce
              className="mt-1 block text-muted-foreground"
            />
          </h1>

          <Fade delay={260} className="mx-auto mt-7 max-w-2xl">
            <p className="text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
              {setting(props.settings, 'hero', 'subtitle', tr('home.hero.subtitle'))}
            </p>
          </Fade>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Magnetic strength={0.12} range={120} className="inline-block">
              <Button
                render={<a href={primaryHref} />}
                nativeButton={false}
                className="h-11 rounded-full px-6"
              >
                {setting(props.settings, 'hero', 'primaryLabel', tr('home.hero.primary'))}
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Button>
            </Magnetic>
            <Button
              render={<a href={secondaryHref} />}
              nativeButton={false}
              variant="secondary"
              className="h-11 rounded-full bg-muted px-6 text-foreground hover:bg-muted/80"
            >
              {setting(props.settings, 'hero', 'secondaryLabel', tr('home.hero.secondary'))}
            </Button>
          </div>

          <div className="mx-auto mt-14 flex max-w-2xl flex-wrap items-center justify-center gap-x-10 gap-y-4 text-xs text-muted-foreground">
            {[
              {
                value: numberSetting(props.settings, 'infrastructure', 'regionsValue', 8),
                decimals: 0,
                suffix: '',
                label: setting(
                  props.settings,
                  'infrastructure',
                  'regionsLabel',
                  tr('home.infra.regionsLabel'),
                ),
              },
              {
                value: numberSetting(props.settings, 'infrastructure', 'azsValue', 24),
                decimals: 0,
                suffix: '',
                label: setting(
                  props.settings,
                  'infrastructure',
                  'azsLabel',
                  tr('home.infra.azsLabel'),
                ),
              },
              {
                value: numberSetting(props.settings, 'infrastructure', 'slaValue', 99.99),
                decimals: 2,
                suffix: '%',
                label: setting(
                  props.settings,
                  'infrastructure',
                  'slaLabel',
                  tr('home.infra.slaLabel'),
                ),
              },
            ].map((item) => (
              <span key={item.label} className="inline-flex items-baseline gap-2">
                <span className="text-lg font-medium text-foreground tabular-nums">
                  <CountingNumber
                    number={item.value}
                    decimalPlaces={item.decimals}
                    thousandSeparator=","
                  />
                  {item.suffix}
                </span>
                {item.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      <LogoWall locale={props.locale} settings={props.settings} />

      {products.length > 0 ? (
        <ProductShowcase
          products={products}
          categories={categories}
          locale={props.locale}
          settings={props.settings}
        />
      ) : null}

      <SolutionsSection locale={props.locale} settings={props.settings} />
      <CasesSection locale={props.locale} settings={props.settings} />
      <InfrastructureSection locale={props.locale} settings={props.settings} />
      <FaqSection locale={props.locale} settings={props.settings} />

      <section className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-6">
        <Slide>
          <div className="flex flex-col items-start justify-between gap-8 rounded-[32px] bg-muted/80 p-8 sm:p-12 lg:flex-row lg:items-end">
            <div>
              <h2 className="max-w-2xl text-3xl font-medium tracking-tight text-balance sm:text-5xl">
                {setting(props.settings, 'closing', 'title', tr('home.cta.title'))}
              </h2>
            </div>
            <div className="max-w-sm">
              <p className="text-sm leading-6 text-muted-foreground">
                {setting(props.settings, 'closing', 'text', tr('home.cta.text'))}
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Magnetic strength={0.1} range={100} className="inline-block">
                  <Button
                    render={<a href={closingPrimaryHref} />}
                    nativeButton={false}
                    className="h-10 rounded-full px-5"
                  >
                    {setting(props.settings, 'closing', 'primaryLabel', tr('home.cta.primary'))}
                    <ArrowUpRight className="size-4" aria-hidden="true" />
                  </Button>
                </Magnetic>
                <Button
                  render={<a href={closingSecondaryHref} />}
                  nativeButton={false}
                  variant="secondary"
                  className="h-10 rounded-full bg-background px-5 text-foreground hover:bg-background/80"
                >
                  {setting(props.settings, 'closing', 'secondaryLabel', tr('home.cta.secondary'))}
                </Button>
              </div>
            </div>
          </div>
        </Slide>
      </section>
    </main>
  );
}
