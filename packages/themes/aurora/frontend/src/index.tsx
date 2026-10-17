import type { ReactElement } from 'react';
import type { FrontendLayoutProps, FrontendPackage, FrontendPageProps } from '@stackpanel/sdk';
import {
  ArrowRight,
  Award,
  Box,
  Building2,
  Check,
  ChevronDown,
  Cloud,
  Code2,
  Cpu,
  Database,
  Gauge,
  Globe,
  HardDrive,
  HeartPulse,
  Layers,
  Menu,
  Network,
  Rocket,
  Server,
  ShieldCheck,
  Sparkles,
  Star,
  Zap,
} from 'lucide-react';
import zhCN from '../messages/zh-CN.json';
import { messages, t } from './i18n.js';

/** Blog slugs are routed data; titles/bodies come from the package catalog. */
const BLOG_POSTS = [
  { slug: 'first-cloud', key: 'content.blog.firstCloud' },
  { slug: 'night-sky', key: 'content.blog.nightSky' },
];

const settingsSchema = {
  groups: [
    {
      id: 'hero',
      labelKey: 'settings.hero.group',
      fields: [
        {
          type: 'text',
          name: 'heroBadge',
          labelKey: 'settings.hero.heroBadge.label',
          default: zhCN['content.hero.heroBadge'],
        },
        {
          type: 'text',
          name: 'heroTitle',
          labelKey: 'settings.hero.heroTitle.label',
          default: zhCN['content.hero.heroTitle'],
        },
        {
          type: 'textarea',
          name: 'heroSubtitle',
          labelKey: 'settings.hero.heroSubtitle.label',
          default: zhCN['content.hero.heroSubtitle'],
          helpKey: 'settings.hero.heroSubtitle.help',
        },
      ],
    },
    {
      id: 'why',
      labelKey: 'settings.why.group',
      fields: [
        {
          type: 'text',
          name: 'whyKicker',
          labelKey: 'settings.why.whyKicker.label',
          default: zhCN['content.why.whyKicker'],
        },
        {
          type: 'text',
          name: 'whyTitle',
          labelKey: 'settings.why.whyTitle.label',
          default: zhCN['content.why.whyTitle'],
        },
        {
          type: 'textarea',
          name: 'whyText',
          labelKey: 'settings.why.whyText.label',
          default: zhCN['content.why.whyText'],
        },
        {
          type: 'text',
          name: 'feature1Title',
          labelKey: 'settings.why.feature1Title.label',
          default: zhCN['content.why.feature1Title'],
        },
        {
          type: 'textarea',
          name: 'feature1Text',
          labelKey: 'settings.why.feature1Text.label',
          default: zhCN['content.why.feature1Text'],
        },
        {
          type: 'text',
          name: 'feature2Title',
          labelKey: 'settings.why.feature2Title.label',
          default: zhCN['content.why.feature2Title'],
        },
        {
          type: 'textarea',
          name: 'feature2Text',
          labelKey: 'settings.why.feature2Text.label',
          default: zhCN['content.why.feature2Text'],
        },
        {
          type: 'text',
          name: 'feature3Title',
          labelKey: 'settings.why.feature3Title.label',
          default: zhCN['content.why.feature3Title'],
        },
        {
          type: 'textarea',
          name: 'feature3Text',
          labelKey: 'settings.why.feature3Text.label',
          default: zhCN['content.why.feature3Text'],
        },
      ],
    },
    {
      id: 'stats',
      labelKey: 'settings.stats.group',
      fields: [
        {
          type: 'text',
          name: 'statsKicker',
          labelKey: 'settings.stats.statsKicker.label',
          default: zhCN['content.stats.statsKicker'],
        },
        {
          type: 'text',
          name: 'statsTitle',
          labelKey: 'settings.stats.statsTitle.label',
          default: zhCN['content.stats.statsTitle'],
        },
        {
          type: 'text',
          name: 'stat1Value',
          labelKey: 'settings.stats.stat1Value.label',
          default: zhCN['content.stats.stat1Value'],
        },
        {
          type: 'text',
          name: 'stat1Label',
          labelKey: 'settings.stats.stat1Label.label',
          default: zhCN['content.stats.stat1Label'],
        },
        {
          type: 'text',
          name: 'stat1Desc',
          labelKey: 'settings.stats.stat1Desc.label',
          default: zhCN['content.stats.stat1Desc'],
        },
        {
          type: 'text',
          name: 'stat2Value',
          labelKey: 'settings.stats.stat2Value.label',
          default: zhCN['content.stats.stat2Value'],
        },
        {
          type: 'text',
          name: 'stat2Label',
          labelKey: 'settings.stats.stat2Label.label',
          default: zhCN['content.stats.stat2Label'],
        },
        {
          type: 'text',
          name: 'stat2Desc',
          labelKey: 'settings.stats.stat2Desc.label',
          default: zhCN['content.stats.stat2Desc'],
        },
        {
          type: 'text',
          name: 'stat3Value',
          labelKey: 'settings.stats.stat3Value.label',
          default: zhCN['content.stats.stat3Value'],
        },
        {
          type: 'text',
          name: 'stat3Label',
          labelKey: 'settings.stats.stat3Label.label',
          default: zhCN['content.stats.stat3Label'],
        },
        {
          type: 'text',
          name: 'stat3Desc',
          labelKey: 'settings.stats.stat3Desc.label',
          default: zhCN['content.stats.stat3Desc'],
        },
      ],
    },
    {
      id: 'cta',
      labelKey: 'settings.cta.group',
      fields: [
        {
          type: 'text',
          name: 'ctaTitle',
          labelKey: 'settings.cta.ctaTitle.label',
          default: zhCN['content.cta.ctaTitle'],
        },
        {
          type: 'textarea',
          name: 'ctaText',
          labelKey: 'settings.cta.ctaText.label',
          default: zhCN['content.cta.ctaText'],
        },
        {
          type: 'text',
          name: 'ctaButton',
          labelKey: 'settings.cta.ctaButton.label',
          default: zhCN['content.cta.ctaButton'],
        },
      ],
    },
  ],
} satisfies NonNullable<FrontendPackage['settingsSchema']>;

const ICONS: Record<string, ReactElement> = {
  arrow: <ArrowRight />,
  award: <Award />,
  box: <Box />,
  building: <Building2 />,
  check: <Check />,
  chevron: <ChevronDown />,
  cloud: <Cloud />,
  code: <Code2 />,
  cpu: <Cpu />,
  database: <Database />,
  gauge: <Gauge />,
  globe: <Globe />,
  drive: <HardDrive />,
  layers: <Layers />,
  menu: <Menu />,
  network: <Network />,
  rocket: <Rocket />,
  server: <Server />,
  shield: <ShieldCheck />,
  spark: <Sparkles />,
  star: <Star />,
  pulse: <HeartPulse />,
  bolt: <Zap />,
};

function Icon({ name }: { name: string }): ReactElement {
  return (
    <span
      className="inline-flex size-[1.15em] shrink-0 items-center justify-center [&_svg]:size-full"
      aria-hidden="true"
    >
      {ICONS[name] ?? <Sparkles />}
    </span>
  );
}

function BrandMark({ size = 'md' }: { size?: 'md' | 'lg' }): ReactElement {
  const box = size === 'lg' ? 'size-10 rounded-2xl' : 'size-9 rounded-xl';
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${box} bg-gradient-to-br from-cyan-400 via-sky-500 to-violet-500 text-sm font-black text-white shadow-lg shadow-sky-500/25 ring-1 ring-white/20`}
    >
      A
    </span>
  );
}

/** Matches category names supplied as catalog data; these are not UI copy. */
function categoryIcon(name: string): string {
  const n = name.toLowerCase();
  if (/(云?服务器|主机|ecs|裸金属|物理机)/.test(n)) return 'server';
  if (/(轻量|应用|建站|wordpress)/.test(n)) return 'cloud';
  if (/(gpu|算力|训练|渲染|推理)/.test(n)) return 'rocket';
  if (/(硬盘|磁盘|块存储|storage)/.test(n)) return 'drive';
  if (/(对象存储|存储|备份|快照|oss)/.test(n)) return 'database';
  if (/(带宽|网络|负载|cdn|加速|线路)/.test(n)) return 'network';
  if (/(高防|安全|防护|ddos|防火墙)/.test(n)) return 'shield';
  if (/(域名|ssl|证书|邮箱|hosting)/.test(n)) return 'globe';
  return 'box';
}

function AuroraLayout({
  children,
  navigation,
  isAuthenticated,
  platform,
  categories = [],
  locale,
}: FrontendLayoutProps): ReactElement {
  const tr = t(locale);
  const navItems = [
    { label: tr('nav.home'), href: '/' },
    ...navigation,
    { label: tr('nav.guide'), href: '/blog' },
  ];
  return (
    <div className="flex min-h-full flex-1 flex-col bg-background" data-theme-layout="aurora">
      <header className="sticky top-0 z-50 border-b border-white/10 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <a href="/" className="group flex items-center gap-2.5 font-semibold tracking-tight">
            <BrandMark />
            <span className="text-[15px] transition-colors group-hover:text-primary">
              {platform.name}
            </span>
          </a>

          <nav className="hidden items-center gap-0.5 lg:flex" aria-label={tr('nav.mainAria')}>
            {categories.length > 0 && (
              <div className="group relative">
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition-colors hover:text-primary"
                  aria-haspopup="true"
                >
                  {tr('nav.products')}
                  <span className="transition-transform duration-200 group-hover:rotate-180">
                    <Icon name="chevron" />
                  </span>
                </button>
                <div className="invisible fixed left-1/2 top-16 z-50 -translate-x-1/2 opacity-0 transition-all duration-200 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
                  <div className="grid w-[44rem] grid-cols-3 gap-6 rounded-3xl border border-white/10 bg-card/95 p-6 shadow-2xl shadow-black/40 backdrop-blur-xl">
                    {categories.map((category) => (
                      <div key={category.id}>
                        <p className="text-xs font-semibold uppercase tracking-widest text-primary">
                          {category.name}
                        </p>
                        {category.children.length > 0 ? (
                          <ul className="mt-3 space-y-1">
                            {category.children.map((child) => (
                              <li key={child.id}>
                                <a
                                  href={`/shop?categoryId=${child.id}`}
                                  className="group/item flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-primary/10"
                                >
                                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400/20 to-violet-500/20 text-primary">
                                    <Icon name={categoryIcon(child.name)} />
                                  </span>
                                  <span>
                                    <span className="block text-sm font-medium text-foreground transition-colors group-hover/item:text-primary">
                                      {child.name}
                                    </span>
                                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                                      {child.productCount > 0
                                        ? tr('categories.count', { count: child.productCount })
                                        : tr('categories.view')}
                                    </span>
                                  </span>
                                </a>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <a
                            href={`/shop?categoryId=${category.id}`}
                            className="mt-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-primary"
                          >
                            {tr('categories.view')}
                            <Icon name="arrow" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="group relative rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground after:absolute after:inset-x-3 after:-bottom-0.5 after:h-px after:origin-center after:scale-x-0 after:rounded-full after:bg-gradient-to-r after:from-cyan-400 after:to-violet-500 after:transition-transform after:duration-300 after:ease-out hover:after:scale-x-100"
              >
                {item.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <a
              href={isAuthenticated ? '/account' : '/login'}
              className="hidden items-center text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
            >
              {isAuthenticated ? tr('nav.account') : tr('nav.login')}
            </a>
            <a
              href="/shop"
              className="group relative hidden items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition-all hover:shadow-xl hover:shadow-violet-500/30 sm:inline-flex"
            >
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-500 group-hover:translate-x-full" />
              <span className="relative">{tr('nav.browse')}</span>
              <Icon name="arrow" />
            </a>
            <details className="group relative lg:hidden">
              <summary className="flex size-9 list-none cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground [&::-webkit-details-marker]:hidden">
                <Icon name="menu" />
              </summary>
              <nav
                className="absolute right-0 top-11 max-h-[70vh] w-72 overflow-y-auto rounded-2xl border border-white/10 bg-card/95 p-1.5 shadow-2xl shadow-black/40 backdrop-blur-xl"
                aria-label={tr('nav.mobileAria')}
              >
                {categories.length > 0 && (
                  <>
                    <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-widest text-primary">
                      {tr('nav.products')}
                    </p>
                    {categories.map((category) => (
                      <div key={category.id} className="mt-1">
                        <a
                          href={`/shop?categoryId=${category.id}`}
                          className="flex items-center justify-between rounded-lg px-3 py-1.5 text-xs font-semibold text-foreground/70"
                        >
                          {category.name}
                          {category.productCount > 0 && (
                            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                              {category.productCount}
                            </span>
                          )}
                        </a>
                        {category.children.length > 0 ? (
                          category.children.map((child) => (
                            <a
                              key={child.id}
                              href={`/shop?categoryId=${child.id}`}
                              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground/90 hover:bg-muted"
                            >
                              <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                                <Icon name={categoryIcon(child.name)} />
                              </span>
                              {child.name}
                            </a>
                          ))
                        ) : (
                          <a
                            href={`/shop?categoryId=${category.id}`}
                            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground/90 hover:bg-muted"
                          >
                            <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                              <Icon name={categoryIcon(category.name)} />
                            </span>
                            {tr('categories.view')}
                          </a>
                        )}
                      </div>
                    ))}
                  </>
                )}
                <div className="mt-2 border-t border-white/10 pt-1">
                  {navItems.map((item) => (
                    <a
                      key={item.href}
                      href={item.href}
                      className="flex items-center justify-between rounded-lg px-3 py-2.5 text-sm text-foreground/90 hover:bg-muted"
                    >
                      {item.label}
                      <span className="text-muted-foreground">
                        <Icon name="arrow" />
                      </span>
                    </a>
                  ))}
                </div>
                <div className="mt-1 space-y-1 border-t border-white/10 pt-1">
                  <a
                    href="/shop"
                    className="flex items-center justify-center rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-3 py-2.5 text-sm font-semibold text-white"
                  >
                    {tr('nav.browse')}
                  </a>
                  <a
                    href={isAuthenticated ? '/account' : '/login'}
                    className="flex items-center justify-center rounded-lg border border-white/10 px-3 py-2.5 text-sm font-medium text-foreground"
                  >
                    {isAuthenticated ? tr('nav.account') : tr('nav.login')}
                  </a>
                </div>
              </nav>
            </details>
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col">{children}</div>

      <footer className="relative overflow-hidden border-t border-white/10 bg-gradient-to-b from-background to-black/40">
        <div
          className="pointer-events-none absolute inset-0 opacity-40 [background-image:radial-gradient(circle_at_50%_120%,color-mix(in_oklch,var(--primary)_18%,transparent),transparent_60%)]"
          aria-hidden="true"
        />
        <div className="relative mx-auto w-full max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="grid gap-10 md:grid-cols-[1.6fr_1fr_1fr_1.2fr]">
            <div>
              <a href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
                <BrandMark size="lg" />
                <span>{platform.name}</span>
              </a>
              <p className="mt-4 max-w-sm text-sm leading-6 text-muted-foreground">
                {tr('footer.tagline')}
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{tr('nav.footerNav')}</p>
              <ul className="mt-4 space-y-2.5 text-sm">
                {navItems.map((item) => (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      className="group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <span className="size-1 -translate-x-1 rounded-full bg-primary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{tr('nav.about')}</p>
              <ul className="mt-4 space-y-2.5 text-sm">
                <li>
                  <a
                    href="/about"
                    className="group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="size-1 -translate-x-1 rounded-full bg-primary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                    {tr('nav.aboutUs')}
                  </a>
                </li>
                <li>
                  <a
                    href="/blog"
                    className="group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="size-1 -translate-x-1 rounded-full bg-primary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                    {tr('nav.guide')}
                  </a>
                </li>
                <li>
                  <a
                    href="/shop"
                    className="group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="size-1 -translate-x-1 rounded-full bg-primary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                    {tr('nav.browse')}
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{tr('nav.accountSection')}</p>
              <ul className="mt-4 space-y-2.5 text-sm">
                <li>
                  <a
                    href={isAuthenticated ? '/account' : '/login'}
                    className="group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="size-1 -translate-x-1 rounded-full bg-primary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                    {isAuthenticated ? tr('nav.account') : tr('nav.login')}
                  </a>
                </li>
                <li>
                  <a
                    href="/account"
                    className="group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="size-1 -translate-x-1 rounded-full bg-primary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                    {tr('nav.orders')}
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-10 flex w-full flex-col justify-between gap-3 border-t border-white/10 pt-6 md:flex-row md:items-center md:gap-4">
            <span className="text-center text-sm leading-tight text-muted-foreground sm:text-left">
              © {new Date().getFullYear()} {platform.name}, Inc.
            </span>
            <div className="flex flex-col flex-wrap items-center justify-center gap-y-2 text-center text-sm leading-tight text-muted-foreground sm:justify-end sm:text-right md:flex-row">
              <a href="/about" className="transition-colors hover:text-foreground">
                {tr('nav.aboutUs')}
              </a>
              <span className="mx-1.5">|</span>
              <a href="/blog" className="transition-colors hover:text-foreground">
                {tr('nav.guide')}
              </a>
              <span className="mx-1.5">|</span>
              <a href="/shop" className="transition-colors hover:text-foreground">
                {tr('nav.browse')}
              </a>
              <span className="mx-1.5">|</span>
              <a href="/about" className="transition-colors hover:text-foreground">
                {tr('nav.privacy')}
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function HomePage({ settings, locale }: FrontendPageProps): ReactElement {
  const tr = t(locale);
  const s = settings.hero ?? {};
  const w = settings.why ?? {};
  const st = settings.stats ?? {};
  const c = settings.cta ?? {};
  const features = [
    {
      icon: 'building',
      title: (w.feature1Title as string) || tr('content.why.feature1Title'),
      text: (w.feature1Text as string) || tr('content.why.feature1Text'),
      href: '/about',
      cta: tr('home.feature.learn'),
    },
    {
      icon: 'award',
      title: (w.feature2Title as string) || tr('content.why.feature2Title'),
      text: (w.feature2Text as string) || tr('content.why.feature2Text'),
      href: '/about',
      cta: tr('home.feature.credentials'),
    },
    {
      icon: 'server',
      title: (w.feature3Title as string) || tr('content.why.feature3Title'),
      text: (w.feature3Text as string) || tr('content.why.feature3Text'),
      href: '/about',
      cta: tr('home.feature.architecture'),
    },
  ];
  const scenes = [
    tr('home.scene.server'),
    tr('home.scene.bandwidth'),
    tr('home.scene.storage'),
    tr('home.scene.cdn'),
    tr('home.scene.highDefense'),
    tr('home.scene.billing'),
  ];
  const testimonials = ['1', '2', '3'].map((index) => ({
    quote: tr(`content.testimonials.${index}.quote`),
    name: tr(`content.testimonials.${index}.name`),
    role: tr(`content.testimonials.${index}.role`),
  }));
  return (
    <main className="flex-1">
      <section className="relative z-0 overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
          aria-hidden="true"
        >
          <div className="absolute -top-40 left-1/2 h-[34rem] w-[48rem] -translate-x-1/2 rounded-full bg-gradient-to-b from-cyan-400/30 via-sky-500/15 to-transparent blur-3xl animate-aurora-1" />
          <div className="absolute -right-24 top-20 h-96 w-96 rounded-full bg-gradient-to-tl from-fuchsia-400/25 to-transparent blur-2xl animate-aurora-2" />
          <div className="absolute -left-24 top-40 h-96 w-96 rounded-full bg-gradient-to-tr from-violet-500/25 to-transparent blur-2xl animate-aurora-3" />
          <div className="absolute inset-0 opacity-30 [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_60%,transparent_100%)]" />
        </div>
        <div className="mx-auto flex w-full max-w-7xl flex-col items-center px-4 pb-16 pt-16 text-center sm:px-6 sm:pb-20 sm:pt-24 lg:px-8">
          <a
            href="/shop"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-background/60 px-3.5 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-primary"
          >
            <span className="flex items-center gap-1.5 text-primary">
              <Icon name="spark" />
              {(s.heroBadge as string) || tr('content.hero.heroBadge')}
            </span>
            {tr('home.start')}
            <Icon name="arrow" />
          </a>
          <h1 className="mt-8 max-w-3xl text-balance bg-gradient-to-br from-cyan-300 via-sky-200 to-violet-300 bg-clip-text text-4xl font-black tracking-tight text-transparent sm:text-6xl">
            {(s.heroTitle as string) || tr('content.hero.heroTitle')}
          </h1>
          <p className="mt-6 max-w-xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg">
            {(s.heroSubtitle as string) || tr('content.hero.heroSubtitle')}
          </p>
          <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
            <a
              href="/shop"
              className="group relative inline-flex h-11 items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-7 text-sm font-semibold text-white shadow-xl shadow-sky-500/30 transition-all hover:scale-[1.02] active:scale-[0.99]"
            >
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-500 group-hover:translate-x-full" />
              <span className="relative">{tr('nav.browse')}</span>
              <Icon name="arrow" />
            </a>
            <a
              href="/about"
              className="inline-flex h-11 items-center gap-2 rounded-xl border border-white/10 bg-background/60 px-7 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:bg-muted/50"
            >
              {tr('home.whyCta')}
            </a>
          </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-gradient-to-r from-cyan-500/5 via-transparent to-violet-500/5 py-10 dark:from-cyan-400/5 dark:via-transparent dark:to-violet-500/5">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <p className="text-center text-xs font-medium uppercase tracking-widest text-muted-foreground">
            {tr('home.scenes')}
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-12 gap-y-4 text-sm font-semibold text-muted-foreground">
            {scenes.map((name) => (
              <span
                key={name}
                className="flex items-center gap-2 opacity-70 transition-opacity hover:opacity-100"
              >
                <span className="flex size-5 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400/20 to-violet-500/20 text-primary">
                  <Icon name="server" />
                </span>
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            {(w.whyKicker as string) || tr('content.why.whyKicker')}
          </p>
          <h2 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            {(w.whyTitle as string) || tr('content.why.whyTitle')}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {(w.whyText as string) || tr('content.why.whyText')}
          </p>
        </div>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {features.map((feature) => (
            <a
              key={feature.title}
              href={feature.href}
              className="group relative flex flex-col overflow-hidden rounded-3xl border border-white/10 bg-card/60 p-7 text-card-foreground shadow-lg shadow-black/5 backdrop-blur transition-all hover:-translate-y-1 hover:border-primary/40 hover:shadow-xl hover:shadow-sky-500/10"
            >
              <div
                className="pointer-events-none absolute -right-16 -top-16 size-44 rounded-full bg-gradient-to-br from-cyan-400/10 to-violet-500/10 blur-3xl opacity-0 transition-opacity group-hover:opacity-100"
                aria-hidden="true"
              />
              <span className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-400/20 to-violet-500/20 text-primary transition-transform group-hover:scale-110">
                <Icon name={feature.icon} />
              </span>
              <h3 className="mt-6 text-lg font-semibold tracking-tight">{feature.title}</h3>
              <p className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">{feature.text}</p>
              <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                {feature.cta}
                <span className="transition-transform group-hover:translate-x-0.5">
                  <Icon name="arrow" />
                </span>
              </span>
            </a>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 pb-20 sm:px-6 sm:pb-24 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            {(st.statsKicker as string) || tr('content.stats.statsKicker')}
          </p>
          <h2 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            {(st.statsTitle as string) || tr('content.stats.statsTitle')}
          </h2>
        </div>
        <div className="mt-12 grid gap-px overflow-hidden rounded-3xl border border-white/10 bg-white/10 sm:grid-cols-3">
          {[
            [
              (st.stat1Value as string) || tr('content.stats.stat1Value'),
              (st.stat1Label as string) || tr('content.stats.stat1Label'),
              (st.stat1Desc as string) || tr('content.stats.stat1Desc'),
            ],
            [
              (st.stat2Value as string) || tr('content.stats.stat2Value'),
              (st.stat2Label as string) || tr('content.stats.stat2Label'),
              (st.stat2Desc as string) || tr('content.stats.stat2Desc'),
            ],
            [
              (st.stat3Value as string) || tr('content.stats.stat3Value'),
              (st.stat3Label as string) || tr('content.stats.stat3Label'),
              (st.stat3Desc as string) || tr('content.stats.stat3Desc'),
            ],
          ].map(([value, label, desc]) => (
            <div key={label} className="bg-background p-8">
              <dd className="bg-gradient-to-r from-cyan-300 to-violet-300 bg-clip-text text-4xl font-black tracking-tight text-transparent">
                {value}
              </dd>
              <dt className="mt-2 text-sm font-semibold">{label}</dt>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-white/10 bg-gradient-to-r from-cyan-500/5 via-transparent to-violet-500/5">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              {tr('home.blogKicker')}
            </p>
            <h2 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              {tr('home.blogTitle')}
            </h2>
          </div>
          <div className="mt-10 grid gap-5 md:grid-cols-2">
            {BLOG_POSTS.map((post) => (
              <a
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="group flex flex-col rounded-3xl border border-white/10 bg-card/60 p-7 text-card-foreground shadow-lg shadow-black/5 backdrop-blur transition-all hover:-translate-y-1 hover:shadow-xl"
              >
                <p className="text-sm font-semibold tracking-tight group-hover:text-primary">
                  {tr(`${post.key}.title`)}
                </p>
                <p className="mt-3 flex-1 text-sm leading-6 text-muted-foreground">
                  {tr(`${post.key}.excerpt`)}
                </p>
                <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                  {tr('blog.readMore')}
                  <span className="transition-transform group-hover:translate-x-0.5">
                    <Icon name="arrow" />
                  </span>
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            {tr('home.testimonialsKicker')}
          </p>
          <h2 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            {tr('home.testimonialsTitle')}
          </h2>
        </div>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {testimonials.map((item) => (
            <figure
              key={item.name}
              className="flex flex-col justify-between rounded-3xl border border-white/10 bg-card/60 p-7 text-card-foreground shadow-lg shadow-black/5 backdrop-blur"
            >
              <blockquote className="text-sm leading-6 text-muted-foreground">
                “{item.quote}”
              </blockquote>
              <figcaption className="mt-6 flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400 to-violet-500 text-sm font-bold text-white">
                  {item.name.slice(0, 1)}
                </span>
                <div>
                  <p className="text-sm font-semibold">{item.name}</p>
                  <p className="text-xs text-muted-foreground">{item.role}</p>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 pb-20 sm:px-6 sm:pb-24 lg:px-8">
        <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-card/60 px-6 py-16 text-center shadow-2xl shadow-black/20 backdrop-blur sm:px-12">
          <div
            className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(40rem_16rem_at_50%_0%,color-mix(in_oklch,var(--primary)_18%,transparent),transparent)]"
            aria-hidden="true"
          />
          <h2 className="relative mx-auto max-w-xl text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            {(c.ctaTitle as string) || tr('content.cta.ctaTitle')}
          </h2>
          <p className="relative mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
            {(c.ctaText as string) || tr('content.cta.ctaText')}
          </p>
          <a
            href="/shop"
            className="group relative mt-8 inline-flex h-11 items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-7 text-sm font-semibold text-white shadow-xl shadow-sky-500/30 transition-transform hover:scale-[1.02] active:scale-[0.99]"
          >
            <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-500 group-hover:translate-x-full" />
            <span className="relative">
              {(c.ctaButton as string) || tr('content.cta.ctaButton')}
            </span>
            <Icon name="arrow" />
          </a>
        </div>
      </section>
    </main>
  );
}

function AboutPage({ locale }: FrontendPageProps): ReactElement {
  const tr = t(locale);
  const values = [
    { label: tr('about.value1.title'), text: tr('about.value1.text') },
    { label: tr('about.value2.title'), text: tr('about.value2.text') },
    { label: tr('about.value3.title'), text: tr('about.value3.text') },
    { label: tr('about.value4.title'), text: tr('about.value4.text') },
  ];
  const principles = [
    { icon: 'building', title: tr('about.principle1.title'), text: tr('about.principle1.text') },
    { icon: 'award', title: tr('about.principle2.title'), text: tr('about.principle2.text') },
    { icon: 'server', title: tr('about.principle3.title'), text: tr('about.principle3.text') },
  ];
  return (
    <main className="flex-1">
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-70 [background:radial-gradient(40rem_18rem_at_50%_-5%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
          aria-hidden="true"
        />
        <div className="mx-auto grid w-full max-w-7xl items-center gap-10 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-2 lg:px-8">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-background/60 px-3.5 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur">
              <span className="flex size-1.5 rounded-full bg-primary" />
              {tr('about.badge')}
            </p>
            <h1 className="mt-6 text-balance text-3xl font-bold tracking-tight sm:text-5xl">
              {tr('about.titleLead')}
              <span className="bg-gradient-to-r from-cyan-300 to-violet-300 bg-clip-text text-transparent">
                {tr('about.titleHighlight')}
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-8 text-muted-foreground">
              {tr('about.intro')}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="/shop"
                className="inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-6 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition-transform hover:scale-[1.02] active:scale-[0.99]"
              >
                {tr('about.browse')}
                <Icon name="arrow" />
              </a>
              <a
                href="/blog"
                className="inline-flex h-11 items-center gap-2 rounded-xl border border-white/10 bg-background/60 px-6 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:bg-muted/50"
              >
                {tr('about.guide')}
              </a>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {values.map((value) => (
              <div
                key={value.label}
                className="rounded-3xl border border-white/10 bg-card/60 p-6 text-card-foreground shadow-lg shadow-black/5 backdrop-blur"
              >
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <span className="flex size-6 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400/20 to-violet-500/20 text-primary">
                    <Icon name="check" />
                  </span>
                  {value.label}
                </p>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{value.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-gradient-to-r from-cyan-500/5 via-transparent to-violet-500/5">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              {tr('about.principlesKicker')}
            </p>
            <h2 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              {tr('about.principlesTitle')}
            </h2>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {principles.map((v) => (
              <div
                key={v.title}
                className="rounded-3xl border border-white/10 bg-card/60 p-7 text-card-foreground shadow-lg shadow-black/5 backdrop-blur"
              >
                <span className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-400/20 to-violet-500/20 text-primary">
                  <Icon name={v.icon} />
                </span>
                <h3 className="mt-6 text-lg font-semibold tracking-tight">{v.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{v.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function BlogPage({ locale }: FrontendPageProps): ReactElement {
  const tr = t(locale);
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
      <div className="relative">
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-50 [background:radial-gradient(24rem_8rem_at_10%_0%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent)]"
          aria-hidden="true"
        />
        <h1 className="mt-6 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
          {tr('blog.title')}
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
          {tr('blog.intro')}
        </p>
      </div>
      <ul className="mt-10 grid gap-5 sm:grid-cols-2">
        {BLOG_POSTS.map((post) => (
          <li key={post.slug}>
            <a
              href={`/blog/${post.slug}`}
              className="group flex h-full flex-col rounded-3xl border border-white/10 bg-card/60 p-7 text-card-foreground shadow-lg shadow-black/5 backdrop-blur transition-all hover:-translate-y-1 hover:border-primary/40 hover:shadow-xl"
            >
              <p className="text-xs font-medium uppercase tracking-widest text-primary">
                {post.slug === 'first-cloud'
                  ? tr('blog.category.select')
                  : tr('blog.category.philosophy')}
              </p>
              <h2 className="mt-3 text-base font-semibold tracking-tight group-hover:text-primary">
                {tr(`${post.key}.title`)}
              </h2>
              <p className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">
                {tr(`${post.key}.excerpt`)}
              </p>
              <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                {tr('blog.readMore')}
                <span className="transition-transform group-hover:translate-x-0.5">
                  <Icon name="arrow" />
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

function BlogPostPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const post = BLOG_POSTS.find((item) => item.slug === props.params.slug);
  if (!post) return <AuroraNotFoundPage {...props} />;
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-14 sm:px-6 sm:py-20">
      <a
        href="/blog"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary"
      >
        <Icon name="arrow" />
        {tr('blog.back')}
      </a>
      <h1 className="mt-8 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
        {tr(`${post.key}.title`)}
      </h1>
      <div className="mt-6 border-t border-white/10 pt-6">
        <p className="text-base leading-8 text-muted-foreground">{tr(`${post.key}.body`)}</p>
      </div>
    </main>
  );
}

function AuroraNotFoundPage({ locale }: FrontendPageProps): ReactElement {
  const tr = t(locale);
  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden px-4 py-24">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-60 [background:radial-gradient(30rem_14rem_at_50%_40%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent)]"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-0 -z-10 [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:3rem_3rem] opacity-20 [mask-image:radial-gradient(ellipse_50%_50%_at_50%_40%,#000_40%,transparent_100%)]"
        aria-hidden="true"
      />
      <div className="mx-auto flex w-full max-w-md flex-col items-center text-center">
        <p className="relative select-none bg-gradient-to-b from-cyan-300 via-sky-400 to-violet-500 bg-clip-text font-mono text-8xl font-black tracking-tight text-transparent drop-shadow-[0_0_2rem_color-mix(in_oklch,var(--primary)_45%,transparent)]">
          404
        </p>
        <h1 className="mt-6 text-2xl font-bold tracking-tight">{tr('notFound.title')}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{tr('notFound.body')}</p>
        <a
          href="/"
          className="mt-8 inline-flex h-10 items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-5 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition-opacity hover:opacity-90"
        >
          {tr('notFound.back')}
          <Icon name="arrow" />
        </a>
      </div>
    </main>
  );
}

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'en-US'],
  messages,
  settingsSchema,
  layouts: { theme: AuroraLayout },
  pages: [
    { path: '/', component: 'home', layout: 'theme' },
    { path: '/about', component: 'about', layout: 'theme' },
    { path: '/blog', component: 'blog', layout: 'theme' },
    { path: '/blog/:slug', component: 'post', layout: 'theme' },
    { path: '*', component: 'notFound', layout: 'theme' },
  ],
  pageComponents: {
    about: AboutPage,
    blog: BlogPage,
    home: HomePage,
    notFound: AuroraNotFoundPage,
    post: BlogPostPage,
  },
};

export default frontend;
