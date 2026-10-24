import { formatMinorCurrency } from '@stackpanel/sdk';
import type { ReactElement } from 'react';
import type { FrontendLayoutProps, FrontendPackage, FrontendPageProps } from '@stackpanel/sdk';
import zhCN from '../messages/zh-CN.json';
import { messages, t } from './i18n.js';
import {
  ArrowRight,
  Box,
  Building2,
  Check,
  ChevronDown,
  Cloud,
  Code2,
  Cpu,
  Database,
  FileText,
  Globe2,
  HardDrive,
  Headphones,
  Layers,
  Lock,
  Menu,
  MessageSquare,
  Network,
  Phone,
  Rocket,
  Search,
  Server,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  Star,
  Trash2,
  Wallet,
  Waves,
  Zap,
} from 'lucide-react';

interface ShopProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number;
  status: string;
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

interface ShopCatalogEntry {
  catalog: { id: string; categoryId: string | null; shelfStatus: string; sortOrder: number };
  product: {
    id: string;
    name: string;
    description: string | null;
    price: number;
    currency: string;
    stock: number;
    status: string;
    metadata: Record<string, unknown> | null;
  };
}

interface ShopCatalogResult {
  products: ShopCatalogEntry[];
  total: number;
  page: number;
  pageSize: number;
  category: { id: string; name: string; slug: string | null; description: string | null } | null;
  query: string | null;
}

interface ShopCartItem {
  id: string;
  productId: string;
  quantity: number;
  product: {
    id: string;
    name: string;
    price: number;
    currency: string;
    stock: number;
    status: string;
    createdAt: string;
  };
  total: number;
}

interface ShopCartPayload {
  items: ShopCartItem[];
  total: number;
}

interface ShopPaymentMethods {
  wallet: { id: string; label: string };
  providers: Array<{
    id: string;
    name: string;
    methods: Array<{ id: string; label: string; topUpAmounts?: number[] }>;
  }>;
}

const BLOG_POSTS = [
  { slug: 'enterprise-cloud', key: 'blog.posts.enterpriseCloud' },
  { slug: 'reliability', key: 'blog.posts.reliability' },
  { slug: 'security', key: 'blog.posts.security' },
  { slug: 'cost', key: 'blog.posts.cost' },
];

const settingsSchema = {
  groups: [
    {
      id: 'hero',
      labelKey: 'settings.hero.group',
      fields: [
        {
          type: 'text',
          name: 'heroKicker',
          labelKey: 'settings.hero.heroKicker.label',
          default: zhCN['content.hero.heroKicker'],
        },
        {
          type: 'text',
          name: 'heroTitleLine',
          labelKey: 'settings.hero.heroTitleLine.label',
          default: zhCN['content.hero.heroTitleLine'],
        },
        {
          type: 'textarea',
          name: 'heroSubtitle',
          labelKey: 'settings.hero.heroSubtitle.label',
          default: zhCN['content.hero.heroSubtitle'],
          helpKey: 'settings.hero.heroSubtitle.help',
        },
        {
          type: 'text',
          name: 'searchPlaceholder',
          labelKey: 'settings.hero.searchPlaceholder.label',
          default: zhCN['content.hero.searchPlaceholder'],
        },
        {
          type: 'text',
          name: 'hotKeywords',
          labelKey: 'settings.hero.hotKeywords.label',
          default: zhCN['content.hero.hotKeywords'],
        },
      ],
    },
    {
      id: 'promo',
      labelKey: 'settings.promo.group',
      fields: [
        {
          type: 'text',
          name: 'promoTag',
          labelKey: 'settings.promo.promoTag.label',
          default: zhCN['content.promo.promoTag'],
        },
        {
          type: 'text',
          name: 'promoTitle',
          labelKey: 'settings.promo.promoTitle.label',
          default: zhCN['content.promo.promoTitle'],
        },
        {
          type: 'text',
          name: 'promoDesc',
          labelKey: 'settings.promo.promoDesc.label',
          default: zhCN['content.promo.promoDesc'],
        },
        {
          type: 'text',
          name: 'promoButton',
          labelKey: 'settings.promo.promoButton.label',
          default: zhCN['content.promo.promoButton'],
        },
      ],
    },
    {
      id: 'models',
      labelKey: 'settings.models.group',
      fields: [
        {
          type: 'text',
          name: 'modelsKicker',
          labelKey: 'settings.models.modelsKicker.label',
          default: zhCN['content.models.modelsKicker'],
        },
        {
          type: 'text',
          name: 'modelsTitle',
          labelKey: 'settings.models.modelsTitle.label',
          default: zhCN['content.models.modelsTitle'],
        },
        {
          type: 'textarea',
          name: 'modelsText',
          labelKey: 'settings.models.modelsText.label',
          default: zhCN['content.models.modelsText'],
        },
      ],
    },
    {
      id: 'products',
      labelKey: 'settings.products.group',
      fields: [
        {
          type: 'text',
          name: 'productsKicker',
          labelKey: 'settings.products.productsKicker.label',
          default: zhCN['content.products.productsKicker'],
        },
        {
          type: 'text',
          name: 'productsTitle',
          labelKey: 'settings.products.productsTitle.label',
          default: zhCN['content.products.productsTitle'],
        },
        {
          type: 'textarea',
          name: 'productsText',
          labelKey: 'settings.products.productsText.label',
          default: zhCN['content.products.productsText'],
        },
        {
          type: 'text',
          name: 'productsLink',
          labelKey: 'settings.products.productsLink.label',
          default: zhCN['content.products.productsLink'],
        },
      ],
    },
    {
      id: 'case',
      labelKey: 'settings.case.group',
      fields: [
        {
          type: 'text',
          name: 'caseKicker',
          labelKey: 'settings.case.caseKicker.label',
          default: zhCN['content.case.caseKicker'],
        },
        {
          type: 'text',
          name: 'caseTitle',
          labelKey: 'settings.case.caseTitle.label',
          default: zhCN['content.case.caseTitle'],
        },
        {
          type: 'text',
          name: 'caseMetric1',
          labelKey: 'settings.case.caseMetric1.label',
          default: zhCN['content.case.caseMetric1'],
        },
        {
          type: 'text',
          name: 'caseMetric1Label',
          labelKey: 'settings.case.caseMetric1Label.label',
          default: zhCN['content.case.caseMetric1Label'],
        },
        {
          type: 'text',
          name: 'caseMetric2',
          labelKey: 'settings.case.caseMetric2.label',
          default: zhCN['content.case.caseMetric2'],
        },
        {
          type: 'text',
          name: 'caseMetric2Label',
          labelKey: 'settings.case.caseMetric2Label.label',
          default: zhCN['content.case.caseMetric2Label'],
        },
      ],
    },
    {
      id: 'infra',
      labelKey: 'settings.infra.group',
      fields: [
        {
          type: 'text',
          name: 'infraKicker',
          labelKey: 'settings.infra.infraKicker.label',
          default: zhCN['content.infra.infraKicker'],
        },
        {
          type: 'text',
          name: 'infraTitle',
          labelKey: 'settings.infra.infraTitle.label',
          default: zhCN['content.infra.infraTitle'],
        },
        {
          type: 'text',
          name: 'infraMetric1',
          labelKey: 'settings.infra.infraMetric1.label',
          default: zhCN['content.infra.infraMetric1'],
        },
        {
          type: 'text',
          name: 'infraMetric1Label',
          labelKey: 'settings.infra.infraMetric1Label.label',
          default: zhCN['content.infra.infraMetric1Label'],
        },
        {
          type: 'text',
          name: 'infraMetric2',
          labelKey: 'settings.infra.infraMetric2.label',
          default: zhCN['content.infra.infraMetric2'],
        },
        {
          type: 'text',
          name: 'infraMetric2Label',
          labelKey: 'settings.infra.infraMetric2Label.label',
          default: zhCN['content.infra.infraMetric2Label'],
        },
        {
          type: 'text',
          name: 'infraMetric3',
          labelKey: 'settings.infra.infraMetric3.label',
          default: zhCN['content.infra.infraMetric3'],
        },
        {
          type: 'text',
          name: 'infraMetric3Label',
          labelKey: 'settings.infra.infraMetric3Label.label',
          default: zhCN['content.infra.infraMetric3Label'],
        },
        {
          type: 'text',
          name: 'infraMetric4',
          labelKey: 'settings.infra.infraMetric4.label',
          default: zhCN['content.infra.infraMetric4'],
        },
        {
          type: 'text',
          name: 'infraMetric4Label',
          labelKey: 'settings.infra.infraMetric4Label.label',
          default: zhCN['content.infra.infraMetric4Label'],
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
        {
          type: 'text',
          name: 'ctaAlt',
          labelKey: 'settings.cta.ctaAlt.label',
          default: zhCN['content.cta.ctaAlt'],
        },
      ],
    },
  ],
} satisfies NonNullable<FrontendPackage['settingsSchema']>;

const ICONS: Record<string, ReactElement> = {
  arrow: <ArrowRight />,
  box: <Box />,
  building: <Building2 />,
  cart: <ShoppingCart />,
  check: <Check />,
  chevron: <ChevronDown />,
  cloud: <Cloud />,
  code: <Code2 />,
  cpu: <Cpu />,
  database: <Database />,
  doc: <FileText />,
  globe: <Globe2 />,
  drive: <HardDrive />,
  headset: <Headphones />,
  layers: <Layers />,
  lock: <Lock />,
  menu: <Menu />,
  msg: <MessageSquare />,
  network: <Network />,
  phone: <Phone />,
  rocket: <Rocket />,
  search: <Search />,
  server: <Server />,
  shield: <ShieldCheck />,
  spark: <Sparkles />,
  star: <Star />,
  trash: <Trash2 />,
  wallet: <Wallet />,
  waves: <Waves />,
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
  const box = size === 'lg' ? 'h-11 w-[44px]' : 'h-9 w-9';
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${box} rounded-md bg-primary text-primary-foreground`}
    >
      <span className={size === 'lg' ? 'text-lg font-semibold' : 'text-sm font-semibold'}>S</span>
    </span>
  );
}

/** Platform brand logo from the active theme; falls back to the built-in mark. */
function BrandLogo({
  brand,
  size = 'md',
}: {
  brand?: FrontendLayoutProps['brand'];
  size?: 'md' | 'lg';
}): ReactElement {
  const box = size === 'lg' ? 'h-11 w-[44px]' : 'h-9 w-9';
  if (brand?.logoUrl) {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden ${box}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={brand.logoUrl} alt="" className="h-full w-full object-contain" />
      </span>
    );
  }
  return <BrandMark size={size} />;
}

function categoryIcon(name: string): string {
  const n = name.toLowerCase();
  // i18n-exempt — patterns match persisted category names (data), not UI copy.
  if (/(云?服务器|主机|ecs|裸金属|物理机|算力)/.test(n)) return 'server';
  // i18n-exempt — patterns match persisted category names (data), not UI copy.
  if (/(轻量|应用|建站|wordpress|redis|memcached)/.test(n)) return 'gauge';
  // i18n-exempt — patterns match persisted category names (data), not UI copy.
  if (/(gpu|训练|渲染|推理|ai|大模型)/.test(n)) return 'rocket';
  // i18n-exempt — patterns match persisted category names (data), not UI copy.
  if (/(硬盘|磁盘|块存储|cbs)/.test(n)) return 'drive';
  // i18n-exempt — patterns match persisted category names (data), not UI copy.
  if (/(对象存储|存储|备份|快照|oss|cos)/.test(n)) return 'database';
  // i18n-exempt — patterns match persisted category names (data), not UI copy.
  if (/(带宽|网络|负载|cdn|加速|线路|ddos|防火墙|waf|安全)/.test(n)) return 'shield';
  // i18n-exempt — patterns match persisted category names (data), not UI copy.
  if (/(域名|ssl|证书|邮箱|hosting)/.test(n)) return 'globe';
  return 'layers';
}

/** Shared enterprise layout: topbar, search header, mega nav, rich footer. */
function StratusLayout({
  children,
  navigation,
  isAuthenticated,
  platform,
  categories = [],
  brand,
  locale,
}: FrontendLayoutProps): ReactElement {
  const tr = t(locale);
  const primaryNav = [
    { label: tr('nav.home'), href: '/' },
    ...navigation,
    { label: tr('nav.solutions'), href: '/about' },
    { label: tr('nav.guides'), href: '/blog' },
  ];
  return (
    <div
      className="flex min-h-full flex-1 flex-col bg-background text-foreground"
      data-theme-layout="stratus"
    >
      {/* Enterprise top utility bar */}
      <div className="bg-topbar text-topbar-foreground">
        <div className="mx-auto flex h-9 w-full max-w-[1680px] items-center justify-between px-4 text-xs sm:px-6 lg:px-12">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <Icon name="phone" />
              {tr('layout.hotline')}
            </span>
            <span className="hidden items-center gap-1.5 sm:flex">
              <Icon name="headset" />
              {tr('layout.onlineSupport')}
            </span>
            <span className="hidden items-center gap-1.5 md:flex">
              <Icon name="msg" />
              {tr('layout.submitTicket')}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <a href="/blog" className="transition-colors hover:text-white">
              {tr('layout.helpDocs')}
            </a>
            <span className="opacity-30" aria-hidden="true">
              |
            </span>
            <a
              href={isAuthenticated ? '/account' : '/login'}
              className="transition-colors hover:text-white"
            >
              {isAuthenticated ? tr('layout.console') : tr('layout.login')}
            </a>
            <span className="opacity-30" aria-hidden="true">
              |
            </span>
            <a
              href={isAuthenticated ? '/account' : '/register'}
              className="transition-colors hover:text-white"
            >
              {isAuthenticated ? tr('layout.account') : tr('layout.register')}
            </a>
          </div>
        </div>
      </div>

      {/* Main header: logo + search + actions */}
      <header className="sticky top-0 z-50 border-b border-border bg-card">
        <div className="mx-auto flex h-[64px] w-full max-w-[1680px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-12">
          <a href="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
            <BrandLogo brand={brand} />
            <span className="text-[15px] text-ink">{platform.name}</span>
          </a>

          <form
            action="/shop"
            method="get"
            className="hidden w-full max-w-[480px] items-stretch rounded-md border border-input bg-background focus-within:border-primary md:flex"
          >
            <label className="flex items-center pl-3 text-ink-faint">
              <span className="size-4">
                <Icon name="search" />
              </span>
              <span className="sr-only">{tr('search.label')}</span>
            </label>
            <input
              type="search"
              name="q"
              placeholder={tr('content.hero.searchPlaceholder')}
              className="h-10 min-w-0 flex-1 bg-transparent px-2.5 text-sm text-ink outline-none placeholder:text-ink-faint"
            />
            <button
              type="submit"
              className="m-1 inline-flex shrink-0 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              {tr('search.submit')}
            </button>
          </form>

          <div className="flex items-center gap-2">
            <a
              href="/shop/cart"
              className="inline-flex size-9 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-muted hover:text-primary"
              aria-label={tr('layout.cart')}
            >
              <Icon name="cart" />
            </a>
            <a
              href={isAuthenticated ? '/account' : '/login'}
              className="hidden items-center rounded-md px-2.5 py-1.5 text-sm text-ink-soft transition-colors hover:text-ink sm:inline-flex"
            >
              {isAuthenticated ? tr('layout.console') : tr('layout.login')}
            </a>
            <a
              href={isAuthenticated ? '/account' : '/register'}
              className="hidden items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:inline-flex"
            >
              {tr('layout.register')}
            </a>
            <details className="group relative lg:hidden">
              <summary className="flex size-9 list-none cursor-pointer items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-muted hover:text-primary [&::-webkit-details-marker]:hidden">
                <Icon name="menu" />
              </summary>
              <nav
                className="absolute right-0 top-11 max-h-[75vh] w-80 overflow-y-auto rounded-md border border-border bg-card p-2 shadow-lg"
                aria-label={tr('layout.mobileNavAria')}
              >
                {categories.length > 0 && (
                  <>
                    <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-widest text-ink-faint">
                      {tr('layout.cloudProducts')}
                    </p>
                    {categories.map((category) => (
                      <div key={category.id} className="mt-1">
                        <a
                          href={`/shop?categoryId=${category.id}`}
                          className="flex items-center justify-between rounded-md px-3 py-1.5 text-xs font-medium text-ink/70"
                        >
                          {category.name}
                          {category.productCount > 0 && (
                            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                              {category.productCount}
                            </span>
                          )}
                        </a>
                        {category.children.length > 0 ? (
                          category.children.map((child) => (
                            <a
                              key={child.id}
                              href={`/shop?categoryId=${child.id}`}
                              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-ink/90 hover:bg-surface"
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
                            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-ink/90 hover:bg-surface"
                          >
                            <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                              <Icon name={categoryIcon(category.name)} />
                            </span>
                            {tr('layout.viewCategory')}
                          </a>
                        )}
                      </div>
                    ))}
                  </>
                )}
                <div className="mt-2 border-t border-border pt-1">
                  {primaryNav.map((item) => (
                    <a
                      key={item.href}
                      href={item.href}
                      className="flex items-center justify-between rounded-md px-3 py-2.5 text-sm text-ink/90 hover:bg-surface"
                    >
                      {item.label}
                      <span className="text-ink-faint">
                        <Icon name="arrow" />
                      </span>
                    </a>
                  ))}
                </div>
              </nav>
            </details>
          </div>
        </div>
      </header>

      {/* Desktop nav bar */}
      <nav
        className="hidden border-b border-border bg-card lg:block"
        aria-label={tr('layout.mainNavAria')}
      >
        <div className="mx-auto flex h-11 w-full max-w-[1680px] items-center px-4 sm:px-6 lg:px-12">
          {categories.length > 0 && (
            <div className="group relative mr-6 flex h-full items-center">
              <a
                href="/shop"
                className="flex h-full items-center gap-1 px-1 text-sm font-medium text-primary transition-colors hover:text-primary"
              >
                <Icon name="cloud" />
                {tr('layout.allProducts')}
                <span className="transition-transform duration-200 group-hover:rotate-180">
                  <Icon name="chevron" />
                </span>
              </a>
              <div className="invisible fixed left-0 top-[104px] z-50 w-full bg-card opacity-0 shadow-xl transition-all duration-200 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
                <div className="mx-auto grid w-full max-w-[1680px] grid-cols-4 gap-x-6 gap-y-1 px-4 py-8 sm:px-6 lg:px-12">
                  {categories.map((category) => (
                    <div key={category.id}>
                      <a
                        href={`/shop?categoryId=${category.id}`}
                        className="flex items-center gap-2 px-2 pb-2 text-sm font-medium text-ink hover:text-primary"
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <Icon name={categoryIcon(category.name)} />
                        </span>
                        {category.name}
                      </a>
                      {category.children.length > 0 ? (
                        <ul className="space-y-0.5 border-t border-border pt-2">
                          {category.children.map((child) => (
                            <li key={child.id}>
                              <a
                                href={`/shop?categoryId=${child.id}`}
                                className="group/item flex items-center justify-between rounded-md px-2 py-1.5 pl-4 text-sm text-ink-soft transition-colors hover:text-primary"
                              >
                                <span>{child.name}</span>
                                {child.productCount > 0 && (
                                  <span className="text-xs text-ink-faint">
                                    {child.productCount}
                                  </span>
                                )}
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {primaryNav.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="flex items-center px-4 text-sm font-medium text-ink transition-colors hover:text-primary"
            >
              {item.label}
            </a>
          ))}
        </div>
      </nav>

      <div className="flex flex-1 flex-col">{children}</div>

      <footer className="border-t border-border bg-card">
        <div className="mx-auto w-full max-w-[1680px] px-4 py-14 sm:px-6 lg:px-12">
          <div className="grid gap-10 lg:grid-cols-[1.2fr_2fr_1fr]">
            <div className="max-w-sm">
              <a href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
                <BrandLogo brand={brand} size="lg" />
                <span className="text-ink">{platform.name}</span>
              </a>
              <p className="mt-4 text-sm leading-6 text-ink-soft">{tr('footer.description')}</p>
              <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-soft">
                {[
                  tr('trust.selfHosted'),
                  tr('trust.grading'),
                  tr('trust.encryption'),
                  tr('trust.audit'),
                  tr('trust.backup'),
                ].map((item) => (
                  <span key={item} className="flex items-center gap-1.5">
                    <span className="text-primary">
                      <Icon name="check" />
                    </span>
                    {item}
                  </span>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
              <div>
                <p className="text-sm font-medium text-ink">{tr('footer.products.title')}</p>
                <ul className="mt-4 space-y-2.5 text-sm">
                  {[
                    tr('footer.products.items.0'),
                    tr('footer.products.items.1'),
                    tr('footer.products.items.2'),
                    tr('footer.products.items.3'),
                    tr('footer.products.items.4'),
                  ].map((item) => (
                    <li key={item}>
                      <a
                        href="/shop"
                        className="text-ink-soft transition-colors hover:text-primary"
                      >
                        {item}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-sm font-medium text-ink">{tr('footer.solutions.title')}</p>
                <ul className="mt-4 space-y-2.5 text-sm">
                  {[
                    tr('footer.solutions.items.0'),
                    tr('footer.solutions.items.1'),
                    tr('footer.solutions.items.2'),
                    tr('footer.solutions.items.3'),
                    tr('footer.solutions.items.4'),
                  ].map((item) => (
                    <li key={item}>
                      <a
                        href="/about"
                        className="text-ink-soft transition-colors hover:text-primary"
                      >
                        {item}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-sm font-medium text-ink">{tr('footer.platform.title')}</p>
                <ul className="mt-4 space-y-2.5 text-sm">
                  <li>
                    <a href="/blog" className="text-ink-soft transition-colors hover:text-primary">
                      {tr('footer.platform.items.0')}
                    </a>
                  </li>
                  <li>
                    <a href="/about" className="text-ink-soft transition-colors hover:text-primary">
                      {tr('footer.platform.items.1')}
                    </a>
                  </li>
                  <li>
                    <a
                      href="/account"
                      className="text-ink-soft transition-colors hover:text-primary"
                    >
                      {tr('footer.platform.items.2')}
                    </a>
                  </li>
                </ul>
              </div>
            </div>
            <div className="flex flex-col items-start gap-4">
              <p className="text-xs uppercase tracking-widest text-ink-faint">
                {tr('footer.hotlineLabel')}
              </p>
              <p className="flex items-center gap-2 text-2xl font-medium tracking-tight text-ink">
                <span className="text-primary">
                  <Icon name="phone" />
                </span>
                400-888-8888
              </p>
              <a
                href={isAuthenticated ? '/account' : '/register'}
                className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                {isAuthenticated ? tr('layout.enterConsole') : tr('layout.register')}
              </a>
            </div>
          </div>
          <div className="mt-10 flex flex-col justify-between gap-3 border-t border-border pt-6 text-sm text-ink-faint md:flex-row md:items-center">
            <span>
              © {new Date().getFullYear()} {platform.name}, Inc.
            </span>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <a href="/about" className="transition-colors hover:text-ink">
                {tr('footer.legal')}
              </a>
              <a href="/about" className="transition-colors hover:text-ink">
                {tr('footer.privacy')}
              </a>
              <a href="/blog" className="transition-colors hover:text-ink">
                {tr('layout.helpDocs')}
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

/** Locale used only when the host does not supply one; never a hardcoded display locale. */
const INTL_FALLBACK_LOCALE = 'en';

/** Format minor units via the kernel currency catalog (no `CNY` branch, no `/100`). */
function money(amount: number, currency: string, locale?: string): string {
  try {
    return formatMinorCurrency(amount, currency, locale ?? INTL_FALLBACK_LOCALE);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** Render a product spec table from metadata (key-value), best-effort ordered. */
function specRows(metadata: Record<string, unknown> | null | undefined): Array<[string, string]> {
  if (!metadata) return [];
  // i18n-exempt — ordering hints matched against persisted metadata keys (data), not UI copy.
  const order = [
    'CPU',
    '内存', // i18n-exempt — persisted metadata key used for ordering.
    '带宽', // i18n-exempt — persisted metadata key used for ordering.
    '流量', // i18n-exempt — persisted metadata key used for ordering.
    '系统盘', // i18n-exempt — persisted metadata key used for ordering.
    '数据盘', // i18n-exempt — persisted metadata key used for ordering.
    '防御', // i18n-exempt — persisted metadata key used for ordering.
    '线路', // i18n-exempt — persisted metadata key used for ordering.
    '机房', // i18n-exempt — persisted metadata key used for ordering.
    '类型', // i18n-exempt — persisted metadata key used for ordering.
    '备注', // i18n-exempt — persisted metadata key used for ordering.
  ];
  const entries = Object.entries(metadata)
    .map(([key, value]): [string, string] => [
      key,
      typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value),
    ])
    .filter(([key, value]) => key && value);
  const rank = (key: string) => {
    const idx = order.findIndex((item) => key.toLowerCase().includes(item.toLowerCase()));
    return idx === -1 ? order.length : idx;
  };
  return entries.sort((a, b) => rank(a[0]) - rank(b[0])).slice(0, 6);
}

/** Featured spec-table pricing card, following the IDC pricing-card pattern. */
function pricingCard(
  product: ShopProduct,
  tr: ReturnType<typeof t>,
  locale?: string,
): ReactElement {
  const rows = specRows(product.metadata);
  const priceText = money(product.price, product.currency, locale);
  const icon = categoryIcon(product.name);
  return (
    <a
      href={`/shop/${product.id}`}
      className="group flex h-full flex-col rounded-lg border border-border bg-card transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Icon name={icon} />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-[15px] font-medium text-ink group-hover:text-primary">
              {product.name}
            </h3>
            {product.description ? (
              <p className="mt-0.5 truncate text-xs text-ink-faint">{product.description}</p>
            ) : null}
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-foreground">
          {product.stock > 0 ? tr('product.inStock') : tr('product.outOfStock')}
        </span>
      </div>

      {rows.length > 0 ? (
        <dl className="grid grid-cols-2 gap-px border-b border-border bg-border">
          {rows.map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-2 bg-card px-4 py-2.5">
              <dt className="text-xs text-ink-faint">{key}</dt>
              <dd className="truncate text-xs font-medium text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="flex-1 border-b border-border bg-surface px-4 py-3" />
      )}

      <div className="flex items-end justify-between gap-3 p-5">
        <div className="flex items-baseline gap-1">
          <span className="text-xl font-semibold text-price">{priceText}</span>
          <span className="text-xs text-ink-faint">{tr('product.priceUnit')}</span>
        </div>
        <span className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm text-ink transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-foreground">
          {tr('product.buy')}
        </span>
      </div>
    </a>
  );
}

function HomePage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const s = props.settings.hero ?? {};
  const pr = props.settings.promo ?? {};
  const md = props.settings.models ?? {};
  const p = props.settings.products ?? {};
  const cs = props.settings.case ?? {};
  const inf = props.settings.infra ?? {};
  const c = props.settings.cta ?? {};
  const hotKeywords = ((s.hotKeywords as string) || tr('content.hero.hotKeywords'))
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const products = (props.data.catalogProducts as ShopCatalogResult | undefined)?.products ?? [];
  const featured = products.slice(0, 8).map((entry) => entry.product);

  const activities = [
    {
      icon: 'spark',
      title: tr('home.activities.newUser.title'),
      desc: tr('home.activities.newUser.description'),
    },
    {
      icon: 'rocket',
      title: tr('home.activities.flashSale.title'),
      desc: tr('home.activities.flashSale.description'),
    },
    {
      icon: 'star',
      title: tr('home.activities.loyal.title'),
      desc: tr('home.activities.loyal.description'),
    },
    {
      icon: 'msg',
      title: tr('home.activities.advisor.title'),
      desc: tr('home.activities.advisor.description'),
    },
  ];

  const services = [
    {
      icon: 'server',
      name: tr('home.services.cloudServer.name'),
      desc: tr('home.services.cloudServer.description'),
    },
    {
      icon: 'drive',
      name: tr('home.services.cloudDisk.name'),
      desc: tr('home.services.cloudDisk.description'),
    },
    {
      icon: 'database',
      name: tr('home.services.objectStorage.name'),
      desc: tr('home.services.objectStorage.description'),
    },
    {
      icon: 'network',
      name: tr('home.services.loadBalancer.name'),
      desc: tr('home.services.loadBalancer.description'),
    },
    {
      icon: 'shield',
      name: tr('home.services.security.name'),
      desc: tr('home.services.security.description'),
    },
    {
      icon: 'globe',
      name: tr('home.services.domain.name'),
      desc: tr('home.services.domain.description'),
    },
    {
      icon: 'rocket',
      name: tr('home.services.gpu.name'),
      desc: tr('home.services.gpu.description'),
    },
    {
      icon: 'code',
      name: tr('home.services.serverless.name'),
      desc: tr('home.services.serverless.description'),
    },
  ];

  const capabilities = [
    {
      icon: 'cpu',
      name: tr('home.capabilities.aiCompute.name'),
      desc: tr('home.capabilities.aiCompute.description'),
    },
    {
      icon: 'rocket',
      name: tr('home.capabilities.llm.name'),
      desc: tr('home.capabilities.llm.description'),
    },
    {
      icon: 'code',
      name: tr('home.capabilities.appDev.name'),
      desc: tr('home.capabilities.appDev.description'),
    },
    {
      icon: 'database',
      name: tr('home.capabilities.vectorDb.name'),
      desc: tr('home.capabilities.vectorDb.description'),
    },
    {
      icon: 'shield',
      name: tr('home.capabilities.security.name'),
      desc: tr('home.capabilities.security.description'),
    },
    {
      icon: 'globe',
      name: tr('home.capabilities.edge.name'),
      desc: tr('home.capabilities.edge.description'),
    },
  ];

  const solutions = [
    {
      icon: 'building',
      name: tr('home.solutions.finance.name'),
      desc: tr('home.solutions.finance.description'),
    },
    {
      icon: 'globe',
      name: tr('home.solutions.ecommerce.name'),
      desc: tr('home.solutions.ecommerce.description'),
    },
    {
      icon: 'rocket',
      name: tr('home.solutions.gaming.name'),
      desc: tr('home.solutions.gaming.description'),
    },
    {
      icon: 'doc',
      name: tr('home.solutions.gov.name'),
      desc: tr('home.solutions.gov.description'),
    },
    {
      icon: 'waves',
      name: tr('home.solutions.media.name'),
      desc: tr('home.solutions.media.description'),
    },
    {
      icon: 'code',
      name: tr('home.solutions.ai.name'),
      desc: tr('home.solutions.ai.description'),
    },
  ];

  const regions = [
    { name: tr('home.regions.north.name'), detail: tr('home.regions.north.detail') },
    { name: tr('home.regions.east.name'), detail: tr('home.regions.east.detail') },
    { name: tr('home.regions.south.name'), detail: tr('home.regions.south.detail') },
    { name: tr('home.regions.southwest.name'), detail: tr('home.regions.southwest.detail') },
    { name: tr('home.regions.hongKong.name'), detail: tr('home.regions.hongKong.detail') },
    { name: tr('home.regions.asiaPacific.name'), detail: tr('home.regions.asiaPacific.detail') },
    { name: tr('home.regions.europe.name'), detail: tr('home.regions.europe.detail') },
    { name: tr('home.regions.americas.name'), detail: tr('home.regions.americas.detail') },
  ];

  return (
    <main className="flex-1">
      {/* Hero */}
      <section className="relative overflow-hidden bg-hero text-hero-foreground">
        <div
          className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(90deg,transparent,#000_10%,#000_90%,transparent)]"
          aria-hidden="true"
        >
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_120%_90%_at_50%_-10%,rgba(94,146,255,0.35),transparent_60%)]" />
        </div>
        <div className="relative mx-auto flex w-full max-w-[1680px] items-center px-4 py-16 sm:px-6 sm:py-20 lg:px-12">
          <div className="max-w-[640px]">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium tracking-[0.14em]">
              {(s.heroKicker as string) || tr('content.hero.heroKicker')}
            </span>
            <h1 className="mt-5 text-[34px] font-semibold leading-[46px] tracking-tight sm:text-[42px]">
              {(s.heroTitleLine as string) || tr('content.hero.heroTitleLine')}
            </h1>
            <p className="mt-4 max-w-md text-sm leading-[22px] text-hero-foreground/80">
              {(s.heroSubtitle as string) || tr('content.hero.heroSubtitle')}
            </p>

            <form
              action="/shop"
              method="get"
              className="mt-8 flex items-stretch overflow-hidden rounded-lg bg-card p-1.5 shadow-lg"
            >
              <span className="flex items-center pl-3 text-ink-faint">
                <span className="size-4">
                  <Icon name="search" />
                </span>
                <span className="sr-only">{tr('search.label')}</span>
              </span>
              <input
                type="search"
                name="q"
                placeholder={tr('content.hero.searchPlaceholder')}
                className="h-11 min-w-0 flex-1 bg-transparent px-2.5 text-sm text-ink outline-none placeholder:text-ink-faint"
              />
              <button
                type="submit"
                className="inline-flex h-11 shrink-0 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                {tr('search.submit')}
              </button>
            </form>

            {hotKeywords.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-hero-foreground/70">
                <span className="flex items-center gap-1">
                  <Icon name="bolt" />
                  {tr('home.hotSearch')}
                </span>
                {hotKeywords.map((keyword) => (
                  <a
                    key={keyword}
                    href={`/shop?q=${encodeURIComponent(keyword)}`}
                    className="rounded-md bg-white/10 px-2 py-0.5 transition-colors hover:bg-white/20"
                  >
                    {keyword}
                  </a>
                ))}
              </div>
            )}

            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-xs text-hero-foreground/80">
              {[
                tr('trust.selfHosted'),
                tr('trust.grading'),
                tr('trust.encryption'),
                tr('trust.audit'),
              ].map((item) => (
                <span key={item} className="flex items-center gap-1.5">
                  <span className="text-white">
                    <Icon name="check" />
                  </span>
                  {item}
                </span>
              ))}
            </div>
          </div>

          <div className="relative ml-auto hidden max-w-[520px] flex-1 lg:block">
            <div className="rounded-lg border border-white/20 bg-card p-6 shadow-xl">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-ink">{tr('home.capabilities.title')}</p>
                <span className="rounded-md bg-accent px-2 py-0.5 text-[11px] text-accent-foreground">
                  {tr('home.capabilities.badge')}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3">
                {capabilities.map((cap) => (
                  <div
                    key={cap.name}
                    className="rounded-md border border-border bg-background p-3 text-center"
                  >
                    <span className="mx-auto flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                      <Icon name={cap.icon} />
                    </span>
                    <p className="mt-2 text-xs font-medium text-ink">{cap.name}</p>
                    <p className="mt-0.5 text-[10px] text-ink-faint">{cap.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Activity quick-nav */}
      <section className="bg-card">
        <div className="mx-auto grid w-full max-w-[1680px] grid-cols-2 gap-4 px-4 py-8 sm:px-6 lg:grid-cols-4 lg:px-12">
          {activities.map((item) => (
            <a
              key={item.title}
              href="/shop"
              className="group flex items-center gap-4 rounded-lg border border-border bg-background p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                <Icon name={item.icon} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink group-hover:text-primary">
                  {item.title}
                </p>
                <p className="mt-0.5 truncate text-xs text-ink-faint">{item.desc}</p>
              </div>
            </a>
          ))}
        </div>
      </section>

      {/* Promo bar */}
      <section className="border-t border-border bg-card">
        <div className="mx-auto w-full max-w-[1680px] px-4 py-5 sm:px-6 lg:px-12">
          <div className="flex items-center gap-4 rounded-md border border-border bg-surface px-5 py-3">
            <span className="rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
              {(pr.promoTag as string) || tr('content.promo.promoTag')}
            </span>
            <p className="min-w-0 truncate text-sm text-ink-soft">
              <span className="font-medium text-ink">
                {(pr.promoTitle as string) || tr('content.promo.promoTitle')}
              </span>
              {pr.promoDesc ? (
                <span className="ml-2 hidden text-ink-faint sm:inline">
                  {pr.promoDesc as string}
                </span>
              ) : null}
            </p>
            <a
              href="/shop"
              className="group ml-auto flex shrink-0 items-center gap-0.5 text-sm font-medium text-primary hover:opacity-80"
            >
              {(pr.promoButton as string) || tr('content.promo.promoButton')}
              <span className="transition-transform group-hover:translate-x-0.5">
                <Icon name="arrow" />
              </span>
            </a>
          </div>
        </div>
      </section>

      {/* Pricing products */}
      <section className="border-t border-border bg-surface">
        <div className="mx-auto w-full max-w-[1680px] px-4 py-16 sm:px-6 lg:px-12">
          <div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div>
              <p className="text-xs leading-5 text-ink-faint">
                {(p.productsKicker as string) || tr('content.products.productsKicker')}
              </p>
              <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
                {(p.productsTitle as string) || tr('content.products.productsTitle')}
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-ink-soft">
                {(p.productsText as string) || tr('content.products.productsText')}
              </p>
            </div>
            <a
              href="/shop"
              className="group inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-ink hover:text-primary"
            >
              {(p.productsLink as string) || tr('content.products.productsLink')}
              <span className="transition-transform group-hover:translate-x-0.5">
                <Icon name="arrow" />
              </span>
            </a>
          </div>
          {featured.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {featured.map((product) => pricingCard(product, tr, props.locale))}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {services.map((item) => (
                <a
                  key={item.name}
                  href="/shop"
                  className="group rounded-lg border border-border bg-card p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                >
                  <span className="flex size-11 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                    <Icon name={item.icon} />
                  </span>
                  <h3 className="mt-4 text-[15px] font-medium text-ink group-hover:text-primary">
                    {item.name}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-ink-faint">{item.desc}</p>
                </a>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Models */}
      <section className="border-t border-border bg-background">
        <div className="mx-auto w-full max-w-[1680px] px-4 py-16 sm:px-6 lg:px-12">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs leading-5 text-ink-faint">
              {(md.modelsKicker as string) || tr('content.models.modelsKicker')}
            </p>
            <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              {(md.modelsTitle as string) || tr('content.models.modelsTitle')}
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-ink-soft">
              {(md.modelsText as string) || tr('content.models.modelsText')}
            </p>
            <div className="mt-6 flex items-center justify-center gap-3 text-sm">
              <a
                href="/shop"
                className="inline-flex h-10 items-center rounded-md bg-primary px-6 font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                {tr('home.models.try')}
              </a>
              <a
                href="/shop"
                className="inline-flex h-10 items-center rounded-md border border-border px-6 text-ink transition-colors hover:border-primary/40 hover:text-primary"
              >
                {tr('home.models.details')}
              </a>
            </div>
          </div>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                name: tr('home.models.hunyuan.name'),
                tag: tr('home.models.hunyuan.tag'),
                note: tr('home.models.hunyuan.note'),
              },
              {
                name: tr('home.models.glm.name'),
                tag: tr('home.models.glm.tag'),
                note: tr('home.models.glm.note'),
              },
              {
                name: tr('home.models.deepseek.name'),
                tag: tr('home.models.deepseek.tag'),
                note: tr('home.models.deepseek.note'),
              },
              {
                name: tr('home.models.minimax.name'),
                tag: tr('home.models.minimax.tag'),
                note: tr('home.models.minimax.note'),
              },
              {
                name: tr('home.models.kimi.name'),
                tag: tr('home.models.kimi.tag'),
                note: tr('home.models.kimi.note'),
              },
              {
                name: tr('home.models.tencent.name'),
                tag: tr('home.models.tencent.tag'),
                note: tr('home.models.tencent.note'),
              },
            ].map((model) => (
              <a
                key={model.name}
                href="/shop"
                className="group rounded-lg border border-border bg-card p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
              >
                <div className="flex items-center justify-between">
                  <span className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    <Icon name="spark" />
                  </span>
                  <span className="rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] text-ink-soft">
                    {model.tag}
                  </span>
                </div>
                <h3 className="mt-4 text-base font-medium tracking-tight text-ink group-hover:text-primary">
                  {model.name}
                </h3>
                <p className="mt-1.5 text-xs leading-5 text-ink-faint">{model.note}</p>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* Solutions */}
      <section className="border-t border-border bg-surface">
        <div className="mx-auto w-full max-w-[1680px] px-4 py-16 sm:px-6 lg:px-12">
          <div className="mb-8 text-center">
            <p className="text-xs leading-5 text-ink-faint">{tr('home.solutions.kicker')}</p>
            <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              {tr('home.solutions.title')}
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-ink-soft">
              {tr('home.solutions.description')}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {solutions.map((item) => (
              <a
                key={item.name}
                href="/about"
                className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
              >
                <div className="flex items-start gap-3 p-5 pt-4">
                  <span className="mt-0.5 text-primary">
                    <Icon name={item.icon} />
                  </span>
                  <div>
                    <h3 className="text-sm font-medium text-ink group-hover:text-primary">
                      {item.name}
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-ink-faint">{item.desc}</p>
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* Case */}
      <section className="border-t border-border bg-background">
        <div className="mx-auto w-full max-w-[1680px] px-4 py-16 sm:px-6 lg:px-12">
          <div className="mb-8 text-center">
            <p className="text-xs leading-5 text-ink-faint">
              {(cs.caseKicker as string) || tr('content.case.caseKicker')}
            </p>
            <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              {(cs.caseTitle as string) || tr('content.case.caseTitle')}
            </h2>
          </div>
          <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr] lg:items-center">
            <div className="rounded-lg border border-border bg-card p-8">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <span className="flex size-12 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    <Icon name="waves" />
                  </span>
                  <div>
                    <p className="text-lg font-medium text-ink">{tr('home.case.name')}</p>
                    <p className="mt-1 text-sm text-ink-faint">{tr('home.case.description')}</p>
                  </div>
                </div>
                <span className="hidden rounded-md bg-accent px-2.5 py-1 text-xs text-accent-foreground sm:block">
                  {tr('home.case.tag')}
                </span>
              </div>
              <div className="mt-8 flex items-center gap-12">
                <div>
                  <p className="text-[36px] font-semibold leading-[44px] tracking-tight text-ink">
                    {(cs.caseMetric1 as string) || tr('content.case.caseMetric1')}
                  </p>
                  <p className="mt-1 text-xs text-ink-faint">
                    {(cs.caseMetric1Label as string) || tr('content.case.caseMetric1Label')}
                  </p>
                </div>
                <div>
                  <p className="text-[36px] font-semibold leading-[44px] tracking-tight text-ink">
                    {(cs.caseMetric2 as string) || tr('content.case.caseMetric2')}
                  </p>
                  <p className="mt-1 text-xs text-ink-faint">
                    {(cs.caseMetric2Label as string) || tr('content.case.caseMetric2Label')}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Infra */}
      <section className="relative overflow-hidden border-t border-border bg-surface">
        <div className="mx-auto w-full max-w-[1680px] px-4 py-16 sm:px-6 lg:px-12">
          <div className="mb-10">
            <p className="text-xs leading-5 text-ink-faint">
              {(inf.infraKicker as string) || tr('content.infra.infraKicker')}
            </p>
            <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              {(inf.infraTitle as string) || tr('content.infra.infraTitle')}
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-12">
            {[
              {
                value: (inf.infraMetric1 as string) || tr('content.infra.infraMetric1'),
                label: (inf.infraMetric1Label as string) || tr('content.infra.infraMetric1Label'),
              },
              {
                value: (inf.infraMetric2 as string) || tr('content.infra.infraMetric2'),
                label: (inf.infraMetric2Label as string) || tr('content.infra.infraMetric2Label'),
              },
              {
                value: (inf.infraMetric3 as string) || tr('content.infra.infraMetric3'),
                label: (inf.infraMetric3Label as string) || tr('content.infra.infraMetric3Label'),
              },
              {
                value: (inf.infraMetric4 as string) || tr('content.infra.infraMetric4'),
                label: (inf.infraMetric4Label as string) || tr('content.infra.infraMetric4Label'),
              },
            ].map((metric) => (
              <div key={metric.label} className="min-w-[136px]">
                <p className="text-[36px] font-semibold leading-[44px] tracking-tight text-ink">
                  {metric.value}
                </p>
                <p className="mt-2 text-sm leading-6 text-ink-soft">{metric.label}</p>
              </div>
            ))}
            <div className="ml-auto hidden items-center gap-2 text-xs text-ink-soft lg:flex">
              <Icon name="globe" />
              {tr('home.infra.coverage')}
            </div>
          </div>
          <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {regions.map((region) => (
              <div
                key={region.name}
                className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40"
              >
                <span className="size-2.5 shrink-0 rounded-full bg-primary" />
                <div>
                  <p className="text-sm font-medium text-ink">{region.name}</p>
                  <p className="text-xs text-ink-faint">{region.detail}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-8 border-t border-border pt-6">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
                {tr('home.infra.guarantee')}
              </span>
              {[
                tr('trust.selfHosted'),
                tr('trust.grading'),
                tr('trust.encryption'),
                tr('trust.audit'),
                tr('trust.backup'),
              ].map((item) => (
                <span key={item} className="flex items-center gap-1.5 text-xs text-ink-soft">
                  <span className="text-primary">
                    <Icon name="check" />
                  </span>
                  {item}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Dev community */}
      <section className="border-t border-border bg-background">
        <div className="mx-auto w-full max-w-[1680px] px-4 py-16 sm:px-6 lg:px-12">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
            <div>
              <p className="text-xs leading-5 text-ink-faint">{tr('home.dev.kicker')}</p>
              <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
                {tr('home.dev.title')}
              </h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-ink-soft">
                {tr('home.dev.description')}
              </p>
              <a
                href="/blog"
                className="group mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:text-primary"
              >
                {tr('home.dev.link')}
                <span className="transition-transform group-hover:translate-x-0.5">
                  <Icon name="arrow" />
                </span>
              </a>
              <div className="mt-10 flex items-center gap-6">
                <div>
                  <p className="text-[36px] font-semibold leading-[44px] tracking-tight text-ink">
                    60+
                  </p>
                  <p className="text-xs text-ink-faint">{tr('home.dev.trials')}</p>
                </div>
                <div className="h-8 w-px bg-border" />
                <div>
                  <p className="text-[36px] font-semibold leading-[44px] tracking-tight text-ink">
                    7×24
                  </p>
                  <p className="text-xs text-ink-faint">{tr('home.dev.support')}</p>
                </div>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                {
                  icon: 'doc',
                  title: tr('home.dev.docs.title'),
                  desc: tr('home.dev.docs.description'),
                },
                {
                  icon: 'code',
                  title: tr('home.dev.quickstart.title'),
                  desc: tr('home.dev.quickstart.description'),
                },
                {
                  icon: 'msg',
                  title: tr('home.dev.qa.title'),
                  desc: tr('home.dev.qa.description'),
                },
                {
                  icon: 'star',
                  title: tr('home.dev.practices.title'),
                  desc: tr('home.dev.practices.description'),
                },
              ].map((item) => (
                <a
                  key={item.title}
                  href="/blog"
                  className="group rounded-lg border border-border bg-card p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                >
                  <span className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    <Icon name={item.icon} />
                  </span>
                  <h3 className="mt-4 text-sm font-medium tracking-tight text-ink group-hover:text-primary">
                    {item.title}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-ink-faint">{item.desc}</p>
                </a>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Blog */}
      <section className="border-t border-border bg-background">
        <div className="mx-auto w-full max-w-[1680px] px-4 pb-16 sm:px-6 lg:px-12">
          <div className="mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div>
              <p className="text-xs leading-5 text-ink-faint">{tr('home.blog.kicker')}</p>
              <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
                {tr('home.blog.title')}
              </h2>
            </div>
            <a
              href="/blog"
              className="group inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:text-primary"
            >
              {tr('home.blog.viewAll')}
              <span className="transition-transform group-hover:translate-x-0.5">
                <Icon name="arrow" />
              </span>
            </a>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {BLOG_POSTS.map((post) => (
              <a
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="group rounded-lg border border-border bg-card p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded-md bg-accent px-2 py-0.5 text-accent-foreground">
                    {tr(`${post.key}.tag`)}
                  </span>
                  <time className="text-ink-faint">2025</time>
                </div>
                <p className="mt-4 text-lg font-medium tracking-tight text-ink group-hover:text-primary">
                  {tr(`${post.key}.title`)}
                </p>
                <p className="mt-2 flex-1 text-sm leading-6 text-ink-faint">
                  {tr(`${post.key}.excerpt`)}
                </p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
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

      {/* CTA */}
      <section className="border-t border-border bg-hero text-hero-foreground">
        <div className="mx-auto w-full max-w-[1680px] px-4 py-16 text-center sm:px-6 lg:px-12">
          <h2 className="text-[30px] font-semibold leading-10 tracking-tight sm:text-[34px]">
            {(c.ctaTitle as string) || tr('content.cta.ctaTitle')}
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-hero-foreground/80">
            {(c.ctaText as string) || tr('content.cta.ctaText')}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="/register"
              className="inline-flex h-11 items-center gap-2 rounded-md bg-primary-foreground px-8 text-sm font-medium text-primary transition-transform hover:scale-[1.02] active:scale-[0.99]"
            >
              {(c.ctaButton as string) || tr('content.cta.ctaButton')}
              <Icon name="arrow" />
            </a>
            <a
              href="/login"
              className="inline-flex h-11 items-center rounded-md border border-white/60 px-8 text-sm font-medium transition-colors hover:bg-white/10"
            >
              {(c.ctaAlt as string) || tr('content.cta.ctaAlt')}
            </a>
          </div>
          <div className="mx-auto mt-12 flex max-w-2xl flex-wrap items-center justify-center gap-x-10 gap-y-4 text-xs text-hero-foreground/80">
            {[
              tr('home.cta.trust.0'),
              tr('home.cta.trust.1'),
              tr('home.cta.trust.2'),
              tr('home.cta.trust.3'),
            ].map((item) => (
              <span key={item} className="flex items-center gap-1.5">
                <Icon name="check" />
                {item}
              </span>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function AboutPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  return (
    <main className="flex-1">
      <section className="relative overflow-hidden bg-hero text-hero-foreground">
        <div
          className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(90deg,transparent,#000_10%,#000_90%,transparent)]"
          aria-hidden="true"
        >
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_120%_90%_at_50%_-10%,rgba(94,146,255,0.35),transparent_60%)]" />
        </div>
        <div className="relative mx-auto w-full max-w-[1680px] px-4 py-20 text-center sm:px-6 lg:px-12">
          <p className="text-xs font-medium tracking-[0.18em] text-hero-foreground/70">
            {tr('about.hero.kicker')}
          </p>
          <h1 className="mt-4 text-balance text-[38px] font-semibold leading-[48px] tracking-tight">
            {tr('about.hero.title')}
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-[22px] text-hero-foreground/80">
            {tr('about.hero.description')}
          </p>
          <div className="mx-auto mt-8 flex w-full max-w-[460px] items-center gap-2 rounded-lg border border-white/20 bg-card p-1.5 shadow-lg">
            <span className="pl-3 text-ink-faint">
              <Icon name="search" />
            </span>
            <input
              type="search"
              aria-label={tr('search.label')}
              placeholder={tr('content.hero.searchPlaceholder')}
              className="h-9 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            />
            <a
              href="/shop"
              className="inline-flex h-9 shrink-0 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              {tr('search.submit')}
            </a>
          </div>
        </div>
      </section>

      <section className="border-t border-border bg-background">
        <div className="mx-auto w-full max-w-[1680px] px-4 py-16 sm:px-6 lg:px-12">
          <div className="mb-8 text-center">
            <p className="text-xs leading-5 text-ink-faint">{tr('about.pillars.kicker')}</p>
            <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              {tr('about.pillars.title')}
            </h2>
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            {[
              {
                icon: 'building',
                title: tr('about.pillars.entity.title'),
                text: tr('about.pillars.entity.description'),
              },
              {
                icon: 'shield',
                title: tr('about.pillars.security.title'),
                text: tr('about.pillars.security.description'),
              },
              {
                icon: 'server',
                title: tr('about.pillars.tech.title'),
                text: tr('about.pillars.tech.description'),
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-lg border border-border bg-card p-7 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
              >
                <span className="flex size-12 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Icon name={item.icon} />
                </span>
                <h3 className="mt-5 text-lg font-medium tracking-tight text-ink">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-ink-faint">{item.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-border bg-surface">
        <div className="mx-auto grid w-full max-w-[1680px] gap-8 px-4 py-16 sm:px-6 md:grid-cols-3 lg:px-12">
          {[
            {
              icon: 'headset',
              title: tr('about.support.247.title'),
              text: tr('about.support.247.description'),
            },
            {
              icon: 'gauge',
              title: tr('about.support.delivery.title'),
              text: tr('about.support.delivery.description'),
            },
            {
              icon: 'doc',
              title: tr('about.support.docs.title'),
              text: tr('about.support.docs.description'),
            },
          ].map((item) => (
            <div key={item.title} className="flex items-start gap-4">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Icon name={item.icon} />
              </span>
              <div>
                <h3 className="text-sm font-medium text-ink">{item.title}</h3>
                <p className="mt-1 text-sm leading-6 text-ink-faint">{item.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function shopCategoryPath(
  nodes: readonly ShopCategoryNode[],
  activeId: string,
): ShopCategoryNode[] | null {
  for (const node of nodes) {
    if (node.id === activeId) return [node];
    const viaChild = shopCategoryPath(node.children, activeId);
    if (viaChild) return [node, ...viaChild];
  }
  return null;
}

function shopCategoryList({
  nodes,
  activeId,
}: {
  nodes: readonly ShopCategoryNode[];
  activeId?: string | undefined;
}): ReactElement {
  return (
    <ul className="space-y-1">
      {nodes.map((node) => {
        const isActive = node.id === activeId;
        return (
          <li key={node.id}>
            <a
              href={`/shop?categoryId=${node.id}`}
              className={`flex h-11 items-center gap-2.5 rounded-md px-3.5 text-sm transition-colors ${
                isActive
                  ? 'bg-primary font-medium text-primary-foreground'
                  : 'text-ink hover:bg-muted hover:text-primary'
              }`}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                <Icon name={categoryIcon(node.name)} />
              </span>
              <span className="whitespace-nowrap">{node.name}</span>
            </a>
            {node.children.length > 0 ? shopCategoryList({ nodes: node.children, activeId }) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ShopPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const categories = (props.data.categories as ShopCategoryNode[] | undefined) ?? null;
  const catalogResult = props.data.catalogProducts as ShopCatalogResult | undefined;
  const active = catalogResult?.category ?? null;
  const activeId = active?.id ?? undefined;
  const query = catalogResult?.query ?? null;
  const entries = catalogResult?.products ?? [];
  const total = catalogResult?.total ?? entries.length;
  const page = catalogResult?.page ?? 1;
  const pageSize = catalogResult?.pageSize ?? 60;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="flex-1 bg-surface">
      <div className="mx-auto w-full max-w-[1600px] px-4 py-12 sm:px-6 lg:px-8">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium leading-5 text-ink-faint">{tr('shop.kicker')}</p>
            <h1 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              {query
                ? tr('shop.searchTitle', { query })
                : activeId && active
                  ? active.name
                  : tr('shop.catalogTitle')}
            </h1>
            <p className="mt-2 text-sm leading-6 text-ink-faint">
              {active?.description ??
                (query ? tr('shop.searchSummary', { query, total }) : tr('shop.summary'))}
            </p>
          </div>
          <a
            href="/shop/cart"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-card px-4 text-sm font-medium text-ink transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground"
          >
            <Icon name="cart" />
            {tr('layout.cart')}
          </a>
        </div>

        <form
          action="/shop"
          method="get"
          className="mb-6 flex max-w-xl items-stretch rounded-md border border-border bg-card focus-within:border-primary"
        >
          <span className="flex items-center pl-3 text-ink-faint">
            <span className="size-4">
              <Icon name="search" />
            </span>
            <span className="sr-only">{tr('search.label')}</span>
          </span>
          <input
            type="search"
            name="q"
            defaultValue={query ?? ''}
            placeholder={tr('shop.searchPlaceholder')}
            className="h-10 min-w-0 flex-1 bg-transparent px-2.5 text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          <button
            type="submit"
            className="m-1 inline-flex shrink-0 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            {tr('search.submit')}
          </button>
        </form>

        {Array.isArray(categories) ? (
          <div className="rounded-lg border border-border bg-card">
            <div className="flex">
              <aside className="hidden w-56 shrink-0 flex-col p-3 lg:flex">
                <a
                  href="/shop"
                  className={`mb-1 flex h-11 items-center gap-2.5 rounded-md px-3.5 text-sm transition-colors ${
                    !activeId && !query
                      ? 'bg-primary font-medium text-primary-foreground'
                      : 'text-ink hover:bg-muted hover:text-primary'
                  }`}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <Icon name="layers" />
                  </span>
                  {tr('shop.allServices')}
                </a>
                {categories.length ? shopCategoryList({ nodes: categories, activeId }) : null}
              </aside>
              <div className="hidden w-px shrink-0 bg-border lg:block" aria-hidden="true" />
              <section className="min-w-0 flex-1 p-4 lg:p-6">
                {activeId && active ? (
                  <nav className="mb-4 flex flex-wrap items-center gap-1 px-2 text-sm text-ink-faint">
                    <a href="/shop" className="transition-colors hover:text-primary">
                      {tr('shop.allServices')}
                    </a>
                    <span>/</span>
                    <span className="text-ink">
                      {shopCategoryPath(categories, activeId)
                        ?.map((n) => n.name)
                        .join(' / ')}
                    </span>
                  </nav>
                ) : null}
                <p className="mb-4 px-2 text-sm text-ink-faint">{tr('shop.count', { total })}</p>
                {entries.length ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {entries.map(({ product }) => pricingCard(product, tr, props.locale))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-background px-6 py-20 text-center">
                    <span className="flex size-12 items-center justify-center rounded-md bg-muted text-ink-faint">
                      <Icon name="box" />
                    </span>
                    <p className="mt-4 text-sm font-medium text-ink-faint">
                      {query ? tr('shop.emptySearch') : tr('shop.emptyCategory')}
                    </p>
                  </div>
                )}
                {pages > 1 ? (
                  <nav
                    className="mt-8 flex items-center justify-center gap-2 text-sm"
                    aria-label={tr('shop.paginationAria')}
                  >
                    {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
                      <a
                        key={n}
                        href={buildShopPageHref(n, activeId, query)}
                        aria-current={n === page ? 'page' : undefined}
                        className={`flex h-8 min-w-8 items-center justify-center rounded-md px-2 transition-colors ${
                          n === page
                            ? 'bg-primary font-medium text-primary-foreground'
                            : 'border border-border bg-card text-ink-faint hover:text-primary'
                        }`}
                      >
                        {n}
                      </a>
                    ))}
                  </nav>
                ) : null}
              </section>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function buildShopPageHref(page: number, activeId?: string, query?: string | null): string {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  if (activeId) params.set('categoryId', activeId);
  if (query) params.set('q', query);
  const qs = params.toString();
  return qs ? `/shop?${qs}` : '/shop';
}

function ShopProductPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const product = props.data.product as ShopProduct | undefined;
  const methods = props.data.methods as ShopPaymentMethods | undefined;
  const viewer = props.data.viewer as { authenticated: boolean } | undefined;
  if (!product) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center bg-surface px-4 py-24 text-center">
        <p className="text-5xl font-bold text-primary">404</p>
        <p className="mt-4 text-sm text-ink-faint">{tr('product.notFound')}</p>
        <a
          href="/shop"
          className="mt-8 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-5 text-sm text-primary-foreground transition-opacity hover:opacity-90"
        >
          {tr('product.backToCatalog')}
          <Icon name="arrow" />
        </a>
      </main>
    );
  }
  const addToCart = props.actions['store.add-to-cart'];
  const walletPurchase = props.actions['store.create-order-wallet'];
  const externalPurchase = props.actions['store.create-order-external'];
  const isAuthed = Boolean(viewer?.authenticated);
  const specs = specRows(product.metadata);
  const priceText = money(product.price, product.currency, props.locale);

  return (
    <main className="flex flex-1 flex-col bg-surface">
      <div className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-10 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <a
            href="/shop"
            className="inline-flex items-center gap-1.5 text-sm text-ink-faint transition-colors hover:text-primary"
          >
            <span className="rotate-180">
              <Icon name="arrow" />
            </span>
            {tr('product.backToCatalog')}
          </a>
          <a
            href="/shop/cart"
            className="inline-flex items-center gap-2 text-sm text-ink-faint transition-colors hover:text-primary"
          >
            <Icon name="cart" />
            {tr('layout.cart')}
          </a>
        </div>

        <div className="mt-6 grid gap-6 rounded-lg border border-border bg-card p-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:p-8">
          <section className="min-w-0">
            <div className="flex items-center gap-4">
              <span className="flex size-14 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <span className="text-2xl">
                  <Icon name={categoryIcon(product.name)} />
                </span>
              </span>
              <div>
                <p className="text-xs font-medium uppercase tracking-widest text-primary">
                  {tr('product.kicker')}
                </p>
                <h1 className="mt-1 text-[26px] font-semibold leading-9 tracking-tight text-ink">
                  {product.name}
                </h1>
              </div>
            </div>
            {product.description ? (
              <p className="mt-6 max-w-2xl text-sm leading-7 text-ink-soft">
                {product.description}
              </p>
            ) : null}
            {specs.length > 0 ? (
              <dl className="mt-8 grid gap-x-8 gap-y-4 border-t border-border pt-6 text-sm sm:grid-cols-2">
                {specs.map(([key, value]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-4 rounded-md bg-surface px-3.5 py-2.5"
                  >
                    <dt className="text-ink-faint">{key}</dt>
                    <dd className="text-right font-medium text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </section>

          <aside className="h-fit rounded-lg border border-border bg-surface p-6 lg:sticky lg:top-24">
            <p className="text-xs font-medium uppercase tracking-widest text-ink-faint">
              {tr('product.price')}
            </p>
            <p className="mt-2 flex items-baseline gap-1">
              <span className="text-[36px] font-semibold leading-[44px] text-price">
                {priceText}
              </span>
              <span className="text-sm text-ink-faint">{tr('product.priceUnitLong')}</span>
            </p>
            <p className="mt-4 text-sm text-ink-soft">
              {product.stock > 0
                ? tr('product.stock', { stock: product.stock })
                : tr('product.unavailable')}
            </p>
            {product.stock > 0 ? (
              <div className="mt-6 space-y-3 border-t border-border pt-5">
                {addToCart ? (
                  isAuthed ? (
                    <form action={addToCart}>
                      <input type="hidden" name="productId" value={product.id} />
                      <label className="block text-xs text-ink-faint">
                        {tr('product.quantity')}
                        <input
                          name="quantity"
                          type="number"
                          min="1"
                          max="100"
                          defaultValue="1"
                          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-colors focus:border-primary"
                        />
                      </label>
                      <button
                        type="submit"
                        className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm text-ink transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground"
                      >
                        <Icon name="cart" />
                        {tr('product.addToCart')}
                      </button>
                    </form>
                  ) : (
                    <a
                      href={`/login?next=${encodeURIComponent(`/shop/${product.id}`)}`}
                      className="flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm text-ink transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground"
                    >
                      <Icon name="cart" />
                      {tr('product.loginToAdd')}
                    </a>
                  )
                ) : null}
                {walletPurchase ? (
                  <form action={walletPurchase}>
                    <input type="hidden" name="productId" value={product.id} />
                    <input type="hidden" name="quantity" value="1" />
                    <button
                      type="submit"
                      className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm text-primary-foreground transition-opacity hover:opacity-90"
                    >
                      <Icon name="wallet" />
                      {tr('product.payWithBalance')}
                    </button>
                  </form>
                ) : null}
                {externalPurchase
                  ? methods?.providers.flatMap((provider) =>
                      provider.methods.map((method) => (
                        <form key={`${provider.id}-${method.id}`} action={externalPurchase}>
                          <input type="hidden" name="productId" value={product.id} />
                          <input type="hidden" name="quantity" value="1" />
                          <input type="hidden" name="providerId" value={provider.id} />
                          <input type="hidden" name="paymentMethod" value={method.id} />
                          <button
                            type="submit"
                            className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm text-ink transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground"
                          >
                            {method.label}
                          </button>
                        </form>
                      )),
                    )
                  : null}
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </main>
  );
}

function ShopCartPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const cart = props.data.cart as ShopCartPayload | undefined;
  const updateQty = props.actions['store.update-cart-item'];
  const removeItem = props.actions['store.remove-cart-item'];
  const checkoutWallet = props.actions['store.checkout-wallet'];
  const checkoutExternal = props.actions['store.checkout-external'];
  const methods = props.data.methods as ShopPaymentMethods | undefined;
  const items = (cart?.items ?? []).filter((item) => item.product.status === 'ACTIVE');
  const hasProviders = Boolean(methods?.providers.length);

  return (
    <main className="flex flex-1 flex-col bg-surface">
      <div className="mx-auto w-full max-w-[980px] flex-1 px-4 py-10 sm:px-6 lg:px-8">
        <a
          href="/shop"
          className="inline-flex items-center gap-1.5 text-sm text-ink-faint transition-colors hover:text-primary"
        >
          <span className="rotate-180">
            <Icon name="arrow" />
          </span>
          {tr('product.backToCatalog')}
        </a>
        <div className="mt-4 mb-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-ink-faint">
              {tr('shop.kicker')}
            </p>
            <h1 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              {tr('cart.title')}
            </h1>
            <p className="mt-2 text-sm text-ink-faint">{tr('cart.subtitle')}</p>
          </div>
        </div>
        {items.length ? (
          <div className="space-y-8">
            <ul className="divide-y divide-border rounded-lg border border-border bg-card p-6">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="grid gap-4 px-2 py-4 sm:grid-cols-[minmax(0,1fr)_9rem_8rem_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Icon name="box" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-medium text-ink">{item.product.name}</p>
                        <p className="mt-0.5 text-xs text-ink-faint">
                          {money(item.product.price, item.product.currency, props.locale)}{' '}
                          {tr('cart.perItem')}
                        </p>
                      </div>
                    </div>
                  </div>
                  {updateQty ? (
                    <div className="flex items-center gap-2">
                      <form action={updateQty} className="flex items-center gap-2">
                        <input type="hidden" name="id" value={item.id} />
                        <input
                          name="quantity"
                          type="number"
                          min="1"
                          max={Math.min(item.product.stock, 100)}
                          defaultValue={item.quantity}
                          className="h-9 w-20 rounded-md border border-input bg-background px-2 text-center text-sm outline-none transition-colors focus:border-primary"
                        />
                        <button
                          type="submit"
                          className="inline-flex h-9 items-center gap-1 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-ink transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground"
                        >
                          {tr('cart.update')}
                        </button>
                      </form>
                    </div>
                  ) : null}
                  <span className="text-lg font-semibold text-price">
                    {money(item.total, item.product.currency, props.locale)}
                  </span>
                  <div className="flex items-start gap-3">
                    {removeItem ? (
                      <form action={removeItem}>
                        <input type="hidden" name="id" value={item.id} />
                        <button
                          type="submit"
                          className="inline-flex size-9 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-destructive/10 hover:text-destructive"
                          aria-label={tr('cart.remove')}
                        >
                          <Icon name="trash" />
                        </button>
                      </form>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>

            <section className="rounded-lg border border-border bg-card p-8">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-ink-faint">{tr('cart.total')}</span>
                <p className="flex items-baseline gap-1">
                  <span className="text-[36px] font-semibold leading-[44px] text-price">
                    {money(
                      cart?.total ?? 0,
                      cart?.items[0]?.product?.currency ?? 'CNY',
                      props.locale,
                    )}
                  </span>
                  <span className="text-sm text-ink-faint">{tr('cart.currencyUnit')}</span>
                </p>
              </div>
              <div className="mt-6 space-y-3 border-t border-border pt-5">
                <p className="text-sm font-medium text-ink">{tr('cart.selectItems')}</p>
                {checkoutWallet ? (
                  <form action={checkoutWallet} className="space-y-3">
                    <ul className="divide-y divide-border rounded-md border border-border bg-card">
                      {items.map((item) => (
                        <li key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                          <input
                            type="checkbox"
                            name="cartItemIds"
                            value={item.id}
                            defaultChecked
                            className="size-4 accent-primary"
                          />
                          <span className="min-w-0 flex-1 truncate text-ink">
                            {item.product.name}
                          </span>
                          <span className="shrink-0 text-sm text-price">
                            {money(item.total, item.product.currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="submit"
                      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm text-primary-foreground transition-opacity hover:opacity-90"
                    >
                      <Icon name="wallet" />
                      {tr('cart.payBalance')}
                    </button>
                  </form>
                ) : null}
                {checkoutExternal && hasProviders
                  ? methods?.providers.flatMap((provider) =>
                      provider.methods.map((method) => (
                        <form
                          key={`${provider.id}-${method.id}`}
                          action={checkoutExternal}
                          className="space-y-3"
                        >
                          <ul className="divide-y divide-border rounded-md border border-border bg-card">
                            {items.map((item) => (
                              <li
                                key={item.id}
                                className="flex items-center gap-3 px-4 py-2.5 text-sm"
                              >
                                <input
                                  type="checkbox"
                                  name="cartItemIds"
                                  value={item.id}
                                  defaultChecked
                                  className="size-4 accent-primary"
                                />
                                <span className="min-w-0 flex-1 truncate text-ink">
                                  {item.product.name}
                                </span>
                                <span className="shrink-0 text-sm text-price">
                                  {money(item.total, item.product.currency)}
                                </span>
                              </li>
                            ))}
                          </ul>
                          <input type="hidden" name="providerId" value={provider.id} />
                          <input type="hidden" name="paymentMethod" value={method.id} />
                          <button
                            type="submit"
                            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm text-ink transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground"
                          >
                            {tr('cart.payWith', { method: method.label })}
                          </button>
                        </form>
                      )),
                    )
                  : null}
              </div>
            </section>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card p-8">
            <div className="flex flex-col items-center px-6 py-16 text-center">
              <span className="flex size-12 items-center justify-center rounded-md bg-muted text-ink-faint">
                <Icon name="box" />
              </span>
              <p className="mt-4 text-sm font-medium text-ink-faint">{tr('cart.empty')}</p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function BlogPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  return (
    <main className="mx-auto w-full max-w-[1000px] flex-1 px-4 py-14 sm:px-6 sm:py-16 lg:px-8">
      <p className="text-xs leading-5 text-ink-faint">{tr('home.blog.kicker')}</p>
      <h1 className="mt-2 text-balance text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
        {tr('blog.title')}
      </h1>
      <p className="mt-3 max-w-xl text-sm leading-6 text-ink-soft">{tr('blog.description')}</p>
      <ul className="mt-10 grid gap-4 sm:grid-cols-2">
        {BLOG_POSTS.map((post) => (
          <li key={post.slug}>
            <a
              href={`/blog/${post.slug}`}
              className="group flex h-full flex-col rounded-lg border border-border bg-card p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              <p className="text-xs font-medium tracking-widest text-primary">
                {tr(`${post.key}.tag`)}
              </p>
              <h2 className="mt-3 text-lg font-medium tracking-tight text-ink group-hover:text-primary">
                {tr(`${post.key}.title`)}
              </h2>
              <p className="mt-2 flex-1 text-sm leading-6 text-ink-faint">
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
  if (!post) return <StratusNotFoundPage {...props} />;
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-14 sm:px-6 sm:py-16">
      <a
        href="/blog"
        className="inline-flex items-center gap-1.5 text-sm text-ink-faint transition-colors hover:text-primary"
      >
        <Icon name="arrow" />
        {tr('blog.back')}
      </a>
      <p className="mt-6 text-xs font-medium uppercase tracking-widest text-primary">
        {tr(`${post.key}.tag`)}
      </p>
      <h1 className="mt-3 text-balance text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
        {tr(`${post.key}.title`)}
      </h1>
      <div className="mt-6 border-t border-border pt-6">
        <p className="text-base leading-8 text-ink-soft">{tr(`${post.key}.body`)}</p>
      </div>
    </main>
  );
}

function StratusNotFoundPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-surface px-4 py-24">
      <div className="relative mx-auto flex w-full max-w-md flex-col items-center text-center">
        <p className="text-8xl font-bold tracking-tight text-primary">404</p>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-ink">
          {tr('notFound.title')}
        </h1>
        <p className="mt-3 text-sm leading-6 text-ink-faint">{tr('notFound.description')}</p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <a
            href="/"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            {tr('notFound.home')}
            <Icon name="arrow" />
          </a>
          <a
            href="/shop"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-card px-5 text-sm font-medium text-ink transition-colors hover:border-primary/40 hover:text-primary"
          >
            {tr('notFound.browse')}
          </a>
        </div>
      </div>
    </main>
  );
}

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  settingsSchema,
  layouts: { theme: StratusLayout },
  pages: [
    {
      path: '/',
      component: 'home',
      layout: 'theme',
      data: [
        { finder: 'catalog.categories', as: 'categories' },
        {
          finder: 'catalog.products',
          as: 'catalogProducts',
          input: { page: 1, pageSize: 8, categoryId: '' },
        },
      ],
    },
    { path: '/about', component: 'about', layout: 'theme' },
    { path: '/blog', component: 'blog', layout: 'theme' },
    { path: '/blog/:slug', component: 'post', layout: 'theme' },
    {
      path: '/shop',
      component: 'shop',
      layout: 'theme',
      data: [
        { finder: 'catalog.categories', as: 'categories' },
        {
          finder: 'catalog.products',
          as: 'catalogProducts',
          input: { page: 1, pageSize: 60, categoryId: '', q: '' },
        },
      ],
    },
    {
      path: '/shop/:id',
      component: 'product',
      layout: 'theme',
      data: [
        { finder: 'store.product', as: 'product', input: { id: ':id' } },
        { finder: 'store.paymentMethods', as: 'methods' },
        { finder: 'store.viewer', as: 'viewer' },
      ],
    },
    {
      path: '/shop/cart',
      component: 'cart',
      layout: 'theme',
      data: [
        { finder: 'store.cart', as: 'cart' },
        { finder: 'store.paymentMethods', as: 'methods' },
      ],
    },
    { path: '*', component: 'notFound', layout: 'theme' },
  ],
  pageComponents: {
    about: AboutPage,
    blog: BlogPage,
    cart: ShopCartPage,
    home: HomePage,
    notFound: StratusNotFoundPage,
    post: BlogPostPage,
    product: ShopProductPage,
    shop: ShopPage,
  },
};

export default frontend;
