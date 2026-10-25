import { formatMinorCurrency } from '@stackpanel/sdk';
import type { FrontendLayoutProps, FrontendPackage, FrontendPageProps } from '@stackpanel/sdk';
import {
  Button,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTab,
} from '@stackpanel/ui';
import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Database,
  Globe2,
  Mail,
  Network,
  Search,
  Server,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Timer,
  Workflow,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { messages, t } from './i18n.js';
import { MOTION_CSS } from './motion-styles.js';
import { safeHref, setting, settingsSchema } from './settings.js';

const INTL_FALLBACK_LOCALE = 'en';
const PAGE_SIZE = 12;

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

interface ShopCatalogEntry {
  catalog: { id: string; categoryId: string | null; shelfStatus: string; sortOrder: number };
  product: ShopProduct;
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
  wallet?: { id: string; label: string };
  providers?: Array<{
    id: string;
    name: string;
    methods: Array<{ id: string; label: string; topUpAmounts?: number[] }>;
  }>;
}

const GUIDE_POSTS = [
  { slug: 'sizing-your-first-server', key: 'guide.post.1' },
  { slug: 'keeping-the-bill-predictable', key: 'guide.post.2' },
  { slug: 'cross-border-latency', key: 'guide.post.3' },
];

const SERVICE_LINKS = [
  { key: 'layout.footerServicesAll', href: '/shop' },
  { key: 'layout.footerServicesCompute', href: '/shop' },
  { key: 'layout.footerServicesStorage', href: '/shop' },
  { key: 'layout.footerServicesNetwork', href: '/shop' },
  { key: 'layout.footerServicesAi', href: '/shop' },
];

const COMPANY_LINKS = [
  { key: 'layout.footerCompanyAbout', href: '/about' },
  { key: 'layout.footerCompanyGuide', href: '/guide' },
  { key: 'layout.footerCompanyContact', href: '/about' },
  { key: 'layout.footerCompanyCareers', href: '/about' },
];

const SUPPORT_LINKS = [
  { key: 'layout.footerSupportDocs', href: '/guide' },
  { key: 'layout.footerSupportStatus', href: '/' },
  { key: 'layout.footerSupportTicket', href: '/about' },
  { key: 'layout.footerSupportSales', href: '/about' },
];

function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function money(amount: number, currency: string, locale?: string): string {
  try {
    return formatMinorCurrency(amount, currency, locale ?? INTL_FALLBACK_LOCALE);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** Persisted product metadata keys used for ordering, not UI copy. */
const SPEC_ORDER = [
  'CPU', // i18n-exempt — persisted metadata key.
  'vCPU',
  '内存', // i18n-exempt — persisted metadata key.
  'Memory',
  '带宽', // i18n-exempt — persisted metadata key.
  'Bandwidth',
  '磁盘', // i18n-exempt — persisted metadata key.
  'Disk',
  'SSD',
  '架构', // i18n-exempt — persisted metadata key.
  'Architecture',
  '区域', // i18n-exempt — persisted metadata key.
  'Region',
];

function specRows(metadata: Record<string, unknown> | null | undefined): Array<[string, string]> {
  if (!metadata) return [];
  const asText = (value: unknown): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  return Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object')
    .sort(([a], [b]) => {
      const ai = SPEC_ORDER.indexOf(a);
      const bi = SPEC_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    })
    .map(([key, value]) => [key, asText(value)]);
}

function flattenCategories(nodes: readonly ShopCategoryNode[]): ShopCategoryNode[] {
  return nodes.flatMap((node) => [node, ...flattenCategories(node.children ?? [])]);
}

function readCategories(value: unknown): ShopCategoryNode[] {
  if (Array.isArray(value)) return value as ShopCategoryNode[];
  const nested = (value as { categories?: ShopCategoryNode[] } | undefined)?.categories;
  return Array.isArray(nested) ? nested : [];
}

function readProducts(data: FrontendPageProps['data']): ShopProduct[] {
  const catalog = data.catalogProducts as ShopCatalogResult | undefined;
  if (catalog?.products?.length) return catalog.products.map((entry) => entry.product);
  return (data.products as ShopProduct[] | undefined) ?? [];
}

function shopHref(page: number, categoryId?: string | null, query?: string | null): string {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  if (categoryId) params.set('categoryId', categoryId);
  if (query) params.set('q', query);
  const qs = params.toString();
  return qs ? `/shop?${qs}` : '/shop';
}

function SectionLabel({ children }: { children: ReactNode }): ReactElement {
  return (
    <span className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function BrandMark(): ReactElement {
  return (
    <span className="flex size-8 items-center justify-center rounded-[10px] bg-foreground text-background">
      <svg viewBox="0 0 32 32" className="size-4" fill="none" aria-hidden="true">
        <path
          d="M9.5 23.5 16 8.5l6.5 15"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M12.6 18.2h6.8" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function ServiceIcon({ name, className }: { name: string; className?: string }): ReactElement {
  const lower = name.toLowerCase();
  const Icon =
    lower.includes('storage') || lower.includes('volume') || lower.includes('postgres')
      ? Database
      : lower.includes('network') || lower.includes('accelerator')
        ? Network
        : lower.includes('compute') || lower.includes('server')
          ? Server
          : lower.includes('model') || lower.includes('ai')
            ? Sparkles
            : Boxes;
  return <Icon className={cn('size-5', className)} aria-hidden="true" />;
}

function AtlasLayout({
  children,
  navigation,
  isAuthenticated,
  brand,
  assetsBaseUrl,
  locale,
  settings,
}: FrontendLayoutProps): ReactElement {
  const tr = t(locale);
  const logoUrl = brand?.logoUrl ?? (assetsBaseUrl ? `${assetsBaseUrl}/logo.svg` : undefined);
  const atlasNav = [
    { label: tr('nav.home'), href: '/' },
    { label: tr('nav.catalog'), href: '/shop' },
    { label: tr('nav.guide'), href: '/guide' },
    { label: tr('nav.about'), href: '/about' },
  ];
  const platformNav = navigation.filter(
    (item) => !atlasNav.some((entry) => entry.href === item.href),
  );
  const nav = [...atlasNav, ...platformNav];
  const socials = [
    {
      key: 'x',
      href: safeHref(setting(settings, 'social', 'xHref', 'https://x.com/'), 'https://x.com/'),
      label: tr('home.social.x'),
      icon: <XMark className="size-3.5" />,
    },
    {
      key: 'github',
      href: safeHref(
        setting(settings, 'social', 'githubHref', 'https://github.com/'),
        'https://github.com/',
      ),
      label: tr('home.social.github'),
      icon: <GitHubMark className="size-4" />,
    },
    {
      key: 'contact',
      href: safeHref(setting(settings, 'social', 'contactHref', '/about'), '/about'),
      label: tr('home.social.contact'),
      icon: <Mail className="size-4" aria-hidden="true" />,
    },
  ];
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-foreground focus:px-4 focus:py-2 focus:text-sm focus:text-background"
      >
        {tr('layout.skip')}
      </a>

      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-20 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <a href="/" className="flex shrink-0 items-center gap-2.5" aria-label={tr('brand.name')}>
            {logoUrl ? (
              <img src={logoUrl} alt="" className="size-8 rounded-[10px]" />
            ) : (
              <BrandMark />
            )}
            <span className="text-[15px] font-medium tracking-tight">{tr('brand.name')}</span>
          </a>

          <nav
            className="ml-6 hidden items-center gap-1 md:flex"
            aria-label={tr('layout.mainNavAria')}
          >
            {nav.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Button
              render={<a href={isAuthenticated ? '/account' : '/login'} />}
              nativeButton={false}
              variant="ghost"
              className="rounded-lg"
            >
              {isAuthenticated ? tr('layout.console') : tr('layout.login')}
            </Button>
            <Button
              render={<a href="/shop/cart" aria-label={tr('layout.cart')} />}
              nativeButton={false}
              variant="outline"
              size="icon"
              className="rounded-lg"
            >
              <ShoppingBag className="size-4" aria-hidden="true" />
            </Button>
            <Button
              render={<a href="/shop" />}
              nativeButton={false}
              className="hidden h-10 rounded-lg px-5 sm:inline-flex"
            >
              {tr('layout.start')}
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto px-4 py-3 md:hidden">
          {nav.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="shrink-0 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              {item.label}
            </a>
          ))}
        </div>
      </header>

      <div id="main" className="flex flex-1 flex-col">
        {children}
      </div>

      <footer className="bg-background">
        <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
          <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <div>
              <a href="/" className="flex items-center gap-2.5">
                {logoUrl ? (
                  <img src={logoUrl} alt="" className="size-8 rounded-[10px]" />
                ) : (
                  <BrandMark />
                )}
                <span className="text-[15px] font-medium tracking-tight">{tr('brand.name')}</span>
              </a>
              <p className="mt-4 max-w-xs text-sm leading-6 text-muted-foreground">
                {tr('layout.footerTagline')}
              </p>
              <div className="mt-5 flex items-center gap-2">
                {socials.map((social) => (
                  <a
                    key={social.key}
                    href={social.href}
                    aria-label={social.label}
                    rel="noreferrer noopener"
                    className="inline-flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {social.icon}
                  </a>
                ))}
              </div>
            </div>
            <FooterColumn
              title={tr('layout.footerServices')}
              links={SERVICE_LINKS}
              locale={locale}
            />
            <FooterColumn
              title={tr('layout.footerCompany')}
              links={COMPANY_LINKS}
              locale={locale}
            />
            <FooterColumn
              title={tr('layout.footerSupport')}
              links={SUPPORT_LINKS}
              locale={locale}
            />
          </div>

          <div className="mt-12 flex flex-col gap-3 pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <p>{tr('layout.footerRights', { year: String(new Date().getFullYear()) })}</p>
            <div className="flex flex-wrap items-center gap-4">
              <span className="inline-flex items-center gap-1.5">
                <Globe2 className="size-3.5" aria-hidden="true" />
                {tr('layout.footerRegion')}
              </span>
              <a href="/about" className="hover:text-foreground">
                {tr('layout.terms')}
              </a>
              <a href="/about" className="hover:text-foreground">
                {tr('layout.privacy')}
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FooterColumn({
  title,
  links,
  locale,
}: {
  title: string;
  links: ReadonlyArray<{ key: string; href: string }>;
  locale?: string | undefined;
}): ReactElement {
  const tr = t(locale);
  return (
    <div>
      <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
        {title}
      </p>
      <ul className="mt-4 space-y-2.5">
        {links.map((link) => (
          <li key={link.key}>
            <a
              href={link.href}
              className="text-sm text-foreground/80 transition-colors hover:text-foreground"
            >
              {tr(link.key)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function XMark({ className }: { className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function GitHubMark({ className }: { className?: string }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.1c-3.2.7-3.88-1.36-3.88-1.36-.53-1.34-1.29-1.7-1.29-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.73 1.27 3.4.97.11-.76.41-1.27.74-1.56-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.41-5.27 5.69.42.36.79 1.08.79 2.18v3.23c0 .3.21.67.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}

const SUPPORTED_LOGOS = [
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

function LogoWall({ tr }: { tr: ReturnType<typeof t> }): ReactElement {
  return (
    <section className="bg-background">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        <p className="text-center text-[10px] font-medium tracking-[0.18em] text-muted-foreground uppercase">
          {tr('home.logos.label')}
        </p>
        <div className="atl-ticker-mask mt-6 overflow-hidden">
          <div className="atl-ticker">
            {[0, 1].map((copy) => (
              <div
                key={copy}
                className="flex shrink-0 items-center gap-10 pr-10 sm:gap-14 sm:pr-14"
                aria-hidden={copy === 1}
              >
                {SUPPORTED_LOGOS.map((logo) => (
                  <span
                    key={logo}
                    className="shrink-0 text-lg font-medium tracking-tight whitespace-nowrap text-muted-foreground/70"
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

function HomePage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const primaryHref = safeHref(setting(props.settings, 'hero', 'primaryHref', '/shop'), '/shop');
  const secondaryHref = safeHref(
    setting(props.settings, 'hero', 'secondaryHref', '/about'),
    '/about',
  );
  const closingPrimaryHref = safeHref(
    setting(props.settings, 'closing', 'primaryHref', '/shop'),
    '/shop',
  );
  const closingSecondaryHref = safeHref(
    setting(props.settings, 'closing', 'secondaryHref', '/guide'),
    '/guide',
  );
  return (
    <main className="flex-1">
      <style dangerouslySetInnerHTML={{ __html: MOTION_CSS }} />

      <section className="relative overflow-hidden">
        <div className="mx-auto w-full max-w-6xl px-4 pb-14 pt-20 sm:px-6 lg:pb-20 lg:pt-24">
          <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
            <TabsRoot defaultValue="compute" className="flex w-full flex-col items-center">
              <h1 className="text-2xl leading-[1.25] font-medium tracking-tight [text-wrap:pretty] sm:text-5xl sm:leading-[1.06] lg:text-6xl">
                <span className="block animate-in fade-in slide-in-from-bottom-4 fill-mode-both duration-700 motion-reduce:animate-none">
                  {setting(props.settings, 'hero', 'title1', tr('home.hero.title1'))}
                </span>
                <span className="mt-1 block animate-in fade-in slide-in-from-bottom-4 fill-mode-both text-muted-foreground duration-700 delay-150 motion-reduce:animate-none">
                  {setting(props.settings, 'hero', 'title2', tr('home.hero.title2'))}
                </span>
              </h1>

              <p className="mt-6 max-w-2xl animate-in fade-in duration-700 delay-200 fill-mode-both text-base leading-7 text-muted-foreground motion-reduce:animate-none sm:text-lg sm:leading-8">
                {setting(props.settings, 'hero', 'subtitle', tr('home.hero.subtitle'))}
              </p>

              {(['compute', 'storage', 'ai'] as const).map((value) => (
                <TabsPanel
                  key={value}
                  value={value}
                  className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground"
                >
                  {tr(`home.tabs.${value}.text`)}
                </TabsPanel>
              ))}

              {/* 标签页控件放在说明文字之后：先说场景，再给切换入口。 */}
              <TabsList className="mt-8 relative inline-flex items-center gap-1 rounded-full bg-muted p-1">
                <TabsTab
                  value="compute"
                  className="relative z-10 rounded-full px-4 py-1.5 text-sm font-medium text-muted-foreground transition-colors data-[active]:bg-background data-[active]:text-foreground"
                >
                  {tr('home.tabs.compute')}
                </TabsTab>
                <TabsTab
                  value="storage"
                  className="relative z-10 rounded-full px-4 py-1.5 text-sm font-medium text-muted-foreground transition-colors data-[active]:bg-background data-[active]:text-foreground"
                >
                  {tr('home.tabs.storage')}
                </TabsTab>
                <TabsTab
                  value="ai"
                  className="relative z-10 rounded-full px-4 py-1.5 text-sm font-medium text-muted-foreground transition-colors data-[active]:bg-background data-[active]:text-foreground"
                >
                  {tr('home.tabs.ai')}
                </TabsTab>
              </TabsList>
            </TabsRoot>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button
                render={<a href={primaryHref} />}
                nativeButton={false}
                className="h-10 rounded-lg px-5"
              >
                {setting(props.settings, 'hero', 'primaryLabel', tr('home.hero.primary'))}
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Button>
              <Button
                render={<a href={secondaryHref} />}
                nativeButton={false}
                variant="secondary"
                className="h-10 rounded-lg px-5"
              >
                {setting(props.settings, 'hero', 'secondaryLabel', tr('home.hero.secondary'))}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <LogoWall tr={tr} />

      <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
          <div className="lg:sticky lg:top-28 lg:self-start">
            <SectionLabel>{tr('home.principles.kicker')}</SectionLabel>
            <h2 className="mt-3 text-3xl font-medium tracking-tight text-balance sm:text-4xl">
              {tr('home.principles.title')}
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-6 text-muted-foreground">
              {tr('home.principles.text')}
            </p>
          </div>
          <div className="flex flex-col gap-4">
            {[1, 2, 3].map((index) => (
              <article
                key={index}
                className="atl-scroll-fade atl-spot group rounded-[20px] border-4 border-border bg-background p-6 transition-colors hover:bg-muted/40 sm:p-8"
              >
                <div className="flex items-center gap-3">
                  <span className="inline-flex size-8 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums text-muted-foreground">
                    {tr(`home.principles.${index}.index`)}
                  </span>
                </div>
                <h3 className="mt-5 text-lg font-medium tracking-tight">
                  {tr(`home.principles.${index}.title`)}
                </h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {tr(`home.principles.${index}.text`)}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <div className="rounded-[24px] bg-muted p-1">
          <div className="rounded-[20px] bg-background px-6 py-12 sm:px-10 sm:py-14">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div>
                <SectionLabel>{tr('home.stats.kicker')}</SectionLabel>
                <h2 className="mt-4 max-w-lg text-3xl font-medium tracking-tight text-balance sm:text-4xl">
                  {tr('home.stats.title')}
                </h2>
              </div>
              <p className="max-w-xs text-sm leading-6 text-muted-foreground">
                {tr('home.stats.text')}
              </p>
            </div>
            <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { value: 99.99, decimals: 2, suffix: '%', label: tr('home.stats.1.label') },
                { value: 8, decimals: 0, suffix: '', label: tr('home.stats.2.label') },
                {
                  value: 5,
                  decimals: 0,
                  suffix: tr('home.stats.3.suffix'),
                  label: tr('home.stats.3.label'),
                },
                { value: 24, decimals: 0, suffix: '/7', label: tr('home.stats.4.label') },
              ].map((stat) => (
                <div key={stat.label} className="border-t-4 border-border pt-5">
                  <p className="text-4xl font-medium tracking-tight tabular-nums">
                    {stat.value.toFixed(stat.decimals)}
                    <span className="text-2xl text-muted-foreground">{stat.suffix}</span>
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">{stat.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-6">
        <div className="grid gap-10 rounded-[24px] border-4 border-border bg-background p-8 lg:grid-cols-[1fr_0.8fr] lg:items-end lg:p-10">
          <div>
            <SectionLabel>{tr('home.cta.kicker')}</SectionLabel>
            <h2 className="mt-3 max-w-2xl text-3xl font-medium tracking-tight text-balance sm:text-5xl">
              {setting(props.settings, 'closing', 'title', tr('home.cta.title'))}
            </h2>
          </div>
          <div>
            <p className="text-sm leading-6 text-muted-foreground">
              {setting(props.settings, 'closing', 'text', tr('home.cta.text'))}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button
                render={<a href={closingPrimaryHref} />}
                nativeButton={false}
                className="h-10 rounded-lg px-5"
              >
                {setting(props.settings, 'closing', 'primaryLabel', tr('home.cta.primary'))}
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Button>
              <Button
                render={<a href={closingSecondaryHref} />}
                nativeButton={false}
                variant="secondary"
                className="h-10 rounded-lg px-5"
              >
                {setting(props.settings, 'closing', 'secondaryLabel', tr('home.cta.secondary'))}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function ProductCard({
  product,
  locale,
}: {
  product: ShopProduct;
  locale?: string | undefined;
}): ReactElement {
  const tr = t(locale);
  const available = product.stock > 0;
  return (
    <div className="atl-scroll-fade h-full">
      <article
        className={cn(
          'group relative flex h-full flex-col gap-0 overflow-hidden rounded-[22px] border-4 border-border bg-card p-0 transition-all duration-300',
          'hover:-translate-y-1 hover:border-foreground/15',
        )}
      >
        <CardHeader className="flex flex-row items-start justify-between gap-3 p-5 pb-0">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-foreground">
            <ServiceIcon name={product.name} />
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] font-medium',
              available ? 'text-muted-foreground' : 'bg-destructive/5 text-destructive',
            )}
          >
            <span
              className={cn('size-1.5 rounded-full', available ? 'bg-success' : 'bg-destructive')}
              aria-hidden="true"
            />
            {available
              ? tr('home.catalog.stock', { count: String(product.stock) })
              : tr('home.catalog.outOfStock')}
          </span>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col p-5 pt-4">
          <CardTitle className="text-base font-medium tracking-tight">
            <a href={`/shop/${product.id}`} className="after:absolute after:inset-0">
              {product.name}
            </a>
          </CardTitle>
          <CardDescription className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
            {product.description ?? tr('product.fallbackDescription')}
          </CardDescription>
          <div className="mt-auto flex items-end justify-between gap-3 border-t-4 border-border pt-4">
            <div>
              <p className="text-[11px] text-muted-foreground">{tr('home.catalog.from')}</p>
              <p className="mt-0.5 text-xl font-medium tracking-tight tabular-nums">
                {money(product.price, product.currency, locale)}
              </p>
            </div>
            <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors group-hover:bg-foreground group-hover:text-background">
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </span>
          </div>
        </CardContent>
      </article>
    </div>
  );
}

function AboutPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  return (
    <main className="flex-1">
      <section className="bg-background">
        <div className="atl-scroll-in mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 lg:py-28">
          <SectionLabel>{tr('about.kicker')}</SectionLabel>
          <h1 className="mt-6 max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-6xl">
            {tr('about.title')}
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
            {tr('about.lead')}
          </p>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:py-24">
        <div>
          <div className="rounded-[20px] border-4 border-border bg-background p-8">
            <p className="text-2xl leading-9 font-medium tracking-tight text-balance">
              “{tr('about.quote')}”
            </p>
            <div className="mt-8 flex items-center gap-3 border-t-4 border-border pt-6 text-sm text-muted-foreground">
              <BrandMark />
              <div>
                <p className="font-medium text-foreground">{tr('brand.name')}</p>
                <p className="text-xs">Infrastructure, written down.</p>
              </div>
            </div>
          </div>
        </div>
        <div className="space-y-10">
          {[1, 2, 3].map((index) => (
            <div key={index} className="atl-scroll-fade border-t-4 border-border pt-6">
              <p className="text-xs font-medium text-muted-foreground">0{index}</p>
              <h2 className="mt-3 text-xl font-medium tracking-tight">
                {tr(`about.p${index}.title`)}
              </h2>
              <p className="mt-2 text-sm leading-7 text-muted-foreground">
                {tr(`about.p${index}.text`)}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-background">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionLabel>{tr('about.timeline.kicker')}</SectionLabel>
          <h2 className="mt-3 text-3xl font-medium tracking-tight">{tr('about.timeline.title')}</h2>
          <div className="mt-10 grid gap-1 overflow-hidden rounded-[20px] bg-muted p-1 sm:grid-cols-3">
            {[1, 2, 3].map((index) => (
              <div key={index} className="atl-scroll-fade rounded-[16px] bg-background p-6">
                <p className="text-sm font-medium text-muted-foreground">
                  {tr(`about.timeline.${index}.year`)}
                </p>
                <h3 className="mt-4 text-base font-semibold">
                  {tr(`about.timeline.${index}.title`)}
                </h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {tr(`about.timeline.${index}.text`)}
                </p>
              </div>
            ))}
          </div>
          <Button render={<a href="/shop" />} nativeButton={false} className="mt-8 rounded-lg">
            {tr('about.cta')}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </section>
    </main>
  );
}

function GuidePage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  return (
    <main className="flex-1">
      <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <SectionLabel>{tr('guide.kicker')}</SectionLabel>
        <h1 className="mt-6 max-w-3xl text-4xl font-medium tracking-tight text-balance sm:text-5xl">
          {tr('guide.title')}
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
          {tr('guide.lead')}
        </p>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {GUIDE_POSTS.map((post) => (
            <div key={post.slug} className="atl-scroll-fade h-full">
              <a
                href={`/guide/${post.slug}`}
                className="group flex h-full flex-col rounded-[22px] border-4 border-border bg-card p-6 transition-all hover:-translate-y-1 hover:border-foreground/15"
              >
                <span className="text-xs text-muted-foreground">
                  {tr(`${post.key}.date`)} ·{' '}
                  {tr('guide.readTime', { minutes: tr(`${post.key}.minutes`) })}
                </span>
                <h2 className="mt-4 text-lg font-medium tracking-tight">
                  {tr(`${post.key}.title`)}
                </h2>
                <p className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">
                  {tr(`${post.key}.excerpt`)}
                </p>
                <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium">
                  {tr('guide.readMore')}
                  <ArrowRight
                    className="size-4 transition-transform group-hover:translate-x-1"
                    aria-hidden="true"
                  />
                </span>
              </a>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function GuidePostPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const slug = props.params.slug;
  const post = GUIDE_POSTS.find((entry) => entry.slug === slug);

  if (!post) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-24 sm:px-6">
        <h1 className="text-3xl font-medium tracking-tight">{tr('guide.notFound')}</h1>
        <Button
          render={<a href="/guide" />}
          nativeButton={false}
          variant="outline"
          className="mt-8 w-fit rounded-full"
        >
          {tr('guide.back')}
        </Button>
      </main>
    );
  }

  const body = tr(`${post.key}.body`)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return (
    <main className="flex-1">
      <article className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6 lg:py-24">
        <a
          href="/guide"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {tr('guide.back')}
        </a>
        <p className="mt-8 text-xs text-muted-foreground">
          {tr(`${post.key}.date`)} · {tr('guide.readTime', { minutes: tr(`${post.key}.minutes`) })}
        </p>
        <h1 className="mt-4 text-4xl font-medium tracking-tight text-balance sm:text-5xl">
          {tr(`${post.key}.title`)}
        </h1>
        <p className="mt-5 text-lg leading-8 text-muted-foreground">{tr(`${post.key}.excerpt`)}</p>
        <div className="mt-10 space-y-5 border-t-4 border-border pt-8 text-[15px] leading-8 text-foreground/85">
          {body.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <div className="mt-12 rounded-[20px] border-4 border-border bg-background p-6">
          <p className="text-sm font-medium">{tr('guide.cta')}</p>
          <Button render={<a href="/about" />} nativeButton={false} className="mt-4 rounded-lg">
            {tr('guide.contactEngineer')}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </article>
    </main>
  );
}

function ShopPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const catalog = props.data.catalogProducts as ShopCatalogResult | undefined;
  const products = readProducts(props.data);
  const categories = [
    ...readCategories(props.data.catalogCategories),
    ...readCategories(props.data.storeCategories),
  ];
  const flat = flattenCategories(categories).filter((category) => !category.parentId);
  const total = catalog?.total ?? products.length;
  const page = catalog?.page ?? 1;
  const pages = Math.max(1, Math.ceil(total / (catalog?.pageSize ?? PAGE_SIZE)));
  const query = catalog?.query ?? '';
  const activeCategory = catalog?.category?.id ?? null;

  return (
    <main className="flex-1">
      <section className="bg-background">
        <div className="atl-scroll-in mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionLabel>{tr('shop.kicker')}</SectionLabel>
          <div className="mt-5 flex flex-wrap items-end justify-between gap-6">
            <div>
              <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">
                {tr('shop.title')}
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
                {tr('shop.lead')}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              {tr('shop.count', { count: String(total) })}
            </p>
          </div>

          <form action="/shop" className="mt-8 flex flex-col gap-3 sm:flex-row">
            <div className="flex h-12 flex-1 items-center gap-2 rounded-xl bg-muted p-1">
              <div className="flex h-full flex-1 items-center gap-2 rounded-lg bg-background px-4">
                <Search className="size-4 text-muted-foreground" aria-hidden="true" />
                <Input
                  name="q"
                  defaultValue={query}
                  aria-label={tr('shop.searchPlaceholder')}
                  placeholder={tr('shop.searchPlaceholder')}
                  className="h-9 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                />
              </div>
            </div>
            {activeCategory ? (
              <input type="hidden" name="categoryId" value={activeCategory} />
            ) : null}
            <Button type="submit" className="h-10 rounded-lg px-6">
              {tr('shop.searchSubmit')}
            </Button>
          </form>

          <div
            className="mt-5 flex flex-wrap items-center gap-2"
            aria-label={tr('shop.filterAria')}
          >
            <a
              href="/shop"
              className={cn(
                'rounded-full px-3.5 py-1.5 text-sm transition-colors',
                !activeCategory
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              {tr('shop.all')}
            </a>
            {flat.map((category) => (
              <a
                key={category.id}
                href={shopHref(1, category.id, query || null)}
                className={cn(
                  'rounded-full px-3.5 py-1.5 text-sm transition-colors',
                  activeCategory === category.id
                    ? 'bg-foreground text-background'
                    : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {category.name}
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
        {query ? (
          <p className="mb-6 text-sm text-muted-foreground">{tr('shop.resultsFor', { query })}</p>
        ) : null}

        {products.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} locale={props.locale} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-start rounded-[20px] border-4 border-border bg-background p-10">
            <Search className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="mt-4 text-sm text-muted-foreground">{tr('shop.empty')}</p>
            <Button
              render={<a href="/shop" />}
              nativeButton={false}
              variant="outline"
              className="mt-5 rounded-lg"
            >
              {tr('shop.clear')}
            </Button>
          </div>
        )}

        {pages > 1 ? (
          <nav
            className="mt-10 flex items-center justify-between pt-2"
            aria-label={tr('shop.paginationAria')}
          >
            <p className="text-sm text-muted-foreground">
              {page} / {pages}
            </p>
            <div className="flex items-center gap-2">
              <Button
                render={<a href={shopHref(Math.max(1, page - 1), activeCategory, query || null)} />}
                nativeButton={false}
                variant="outline"
                size="icon"
                className="rounded-full"
                aria-label={tr('shop.prev')}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </Button>
              <Button
                render={
                  <a href={shopHref(Math.min(pages, page + 1), activeCategory, query || null)} />
                }
                nativeButton={false}
                variant="outline"
                size="icon"
                className="rounded-full"
                aria-label={tr('shop.next')}
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </nav>
        ) : null}
      </section>
    </main>
  );
}

function ShopProductPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const product = props.data.product as ShopProduct | undefined;
  const methods = props.data.methods as ShopPaymentMethods | undefined;
  const addToCart = props.actions['store.add-to-cart'];
  const walletPurchase = props.actions['store.create-order-wallet'];
  const externalPurchase = props.actions['store.create-order-external'];
  const retryHref = `/shop/${product?.id ?? ''}`;
  const specs = specRows(product?.metadata);

  if (!product) {
    return (
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-24 sm:px-6">
        <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">404</p>
        <h1 className="mt-4 text-3xl font-medium tracking-tight">{tr('product.notFound')}</h1>
        <Button
          render={<a href="/shop" />}
          nativeButton={false}
          variant="outline"
          className="mt-8 w-fit rounded-full"
        >
          {tr('product.back')}
        </Button>
      </main>
    );
  }

  const available = product.stock > 0;

  return (
    <main className="flex-1">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:py-16">
        <a
          href="/shop"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {tr('product.back')}
        </a>

        <div className="mt-8 grid gap-10 lg:grid-cols-[1.35fr_0.8fr] lg:items-start">
          <div>
            <div className="flex items-center gap-3">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-muted">
                <ServiceIcon name={product.name} className="size-6" />
              </span>
              <div>
                <p className="text-xs text-muted-foreground">{tr('product.kicker')}</p>
                <p className="text-xs text-muted-foreground">
                  {tr('product.sku')} · {product.id.slice(0, 8)}
                </p>
              </div>
            </div>

            <h1 className="mt-6 text-4xl font-medium tracking-tight text-balance sm:text-5xl">
              {product.name}
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
              {product.description ?? tr('product.description')}
            </p>

            {specs.length > 0 ? (
              <div className="mt-8 grid gap-1 overflow-hidden rounded-[20px] bg-muted p-1 sm:grid-cols-2">
                {specs.map(([key, value]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-4 bg-background px-5 py-4"
                  >
                    <span className="text-sm text-muted-foreground">{key}</span>
                    <span className="text-right text-sm font-medium">{value}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-8 rounded-xl bg-muted px-5 py-4 text-sm text-muted-foreground">
                {tr('product.noSpecs')}
              </div>
            )}

            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              {[
                { icon: ShieldCheck, key: 1 },
                { icon: Timer, key: 2 },
                { icon: Workflow, key: 3 },
              ].map((item) => (
                <div key={item.key} className="rounded-xl bg-muted p-4">
                  <item.icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  <p className="mt-3 text-xs text-muted-foreground">
                    {tr(`product.feature${item.key}.label`)}
                  </p>
                  <p className="mt-1 text-sm font-medium">
                    {tr(`product.feature${item.key}.value`)}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <aside className="rounded-[22px] border-4 border-border bg-card p-6 lg:sticky lg:top-24">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs text-muted-foreground">{tr('product.price')}</p>
                <p className="mt-1 text-3xl font-medium tracking-tight tabular-nums">
                  {money(product.price, product.currency, props.locale)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{tr('product.unit')}</p>
              </div>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px]',
                  available ? 'text-muted-foreground' : 'text-destructive',
                )}
              >
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    available ? 'bg-success' : 'bg-destructive',
                  )}
                  aria-hidden="true"
                />
                {available ? tr('product.available') : tr('product.outOfStock')}
              </span>
            </div>

            <div className="mt-6 space-y-4 border-t-4 border-border pt-6">
              {available ? (
                <>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{tr('product.stock')}</span>
                    <span className="font-medium tabular-nums">{product.stock}</span>
                  </div>

                  {addToCart ? (
                    <form action={addToCart} className="space-y-3">
                      <input type="hidden" name="productId" value={product.id} />
                      <label className="flex items-center justify-between gap-3 text-sm">
                        <span className="shrink-0 text-muted-foreground">
                          {tr('product.quantity')}
                        </span>
                        <Input
                          type="number"
                          name="quantity"
                          min={1}
                          max={Math.min(product.stock, 99)}
                          defaultValue={1}
                          className="h-9 w-24 text-right"
                        />
                      </label>
                      <Button type="submit" className="h-10 w-full rounded-lg">
                        <ShoppingBag className="size-4" aria-hidden="true" />
                        {tr('product.addToCart')}
                      </Button>
                    </form>
                  ) : (
                    <Button
                      render={<a href={`/login?next=${encodeURIComponent(retryHref)}`} />}
                      nativeButton={false}
                      className="h-10 w-full rounded-lg"
                    >
                      <ShoppingBag className="size-4" aria-hidden="true" />
                      {tr('product.loginToAdd')}
                    </Button>
                  )}

                  {walletPurchase ? (
                    <form action={walletPurchase}>
                      <input type="hidden" name="productId" value={product.id} />
                      <input type="hidden" name="quantity" value="1" />
                      <Button type="submit" variant="outline" className="h-10 w-full rounded-lg">
                        <ShieldCheck className="size-4" aria-hidden="true" />
                        {tr('product.payWithBalance')}
                      </Button>
                    </form>
                  ) : null}

                  {externalPurchase
                    ? methods?.providers?.flatMap((provider) =>
                        provider.methods.map((method) => (
                          <form key={`${provider.id}-${method.id}`} action={externalPurchase}>
                            <input type="hidden" name="productId" value={product.id} />
                            <input type="hidden" name="quantity" value="1" />
                            <input type="hidden" name="providerId" value={provider.id} />
                            <input type="hidden" name="paymentMethod" value={method.id} />
                            <Button
                              type="submit"
                              variant="ghost"
                              className="h-10 w-full rounded-full text-muted-foreground"
                            >
                              {tr('product.payWith', { method: method.label })}
                            </Button>
                          </form>
                        )),
                      )
                    : null}
                </>
              ) : (
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <CircleDot className="size-4" aria-hidden="true" />
                  {tr('product.outOfStock')}
                </p>
              )}
            </div>

            <a
              href="/shop/cart"
              className="mt-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              {tr('product.viewCart')}
              <ArrowRight className="size-4" aria-hidden="true" />
            </a>
          </aside>
        </div>
      </div>
    </main>
  );
}

function ShopCartPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const cart = props.data.cart as ShopCartPayload | undefined;
  const methods = props.data.methods as ShopPaymentMethods | undefined;
  const items = cart?.items ?? [];
  const updateQuantity = props.actions['store.update-cart-item'];
  const removeItem = props.actions['store.remove-cart-item'];
  const checkoutWallet = props.actions['store.checkout-wallet'];
  const checkoutExternal = props.actions['store.checkout-external'];

  return (
    <main className="flex-1">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 lg:py-20">
        <SectionLabel>CART</SectionLabel>
        <h1 className="mt-4 text-4xl font-medium tracking-tight">{tr('cart.title')}</h1>
        <p className="mt-3 text-sm text-muted-foreground">{tr('cart.lead')}</p>

        {items.length > 0 ? (
          <div className="mt-10 grid gap-8 lg:grid-cols-[1.5fr_0.75fr] lg:items-start">
            <section className="overflow-hidden rounded-[22px] border-4 border-border bg-card">
              <div className="hidden grid-cols-[1fr_130px_120px] gap-4 bg-muted px-5 py-3 text-xs text-muted-foreground sm:grid">
                <span>{tr('cart.summary')}</span>
                <span>{tr('cart.quantity')}</span>
                <span className="text-right">{tr('cart.total')}</span>
              </div>
              {items.map((item) => (
                <div key={item.id} className="border-b-4 border-border px-5 py-5 last:border-b-0">
                  <div className="grid gap-4 sm:grid-cols-[1fr_130px_120px] sm:items-center">
                    <div className="min-w-0">
                      <a
                        href={`/shop/${item.product.id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {item.product.name}
                      </a>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {money(item.product.price, item.product.currency, props.locale)} ·{' '}
                        {tr('cart.perItem')}
                      </p>
                      {removeItem ? (
                        <form action={removeItem} className="mt-2">
                          <input type="hidden" name="id" value={item.id} />
                          <button
                            type="submit"
                            className="text-xs text-muted-foreground hover:text-destructive"
                          >
                            {tr('cart.remove')}
                          </button>
                        </form>
                      ) : null}
                    </div>
                    <div>
                      {updateQuantity ? (
                        <form action={updateQuantity} className="flex items-center gap-2">
                          <input type="hidden" name="id" value={item.id} />
                          <Input
                            type="number"
                            name="quantity"
                            min={1}
                            max={Math.max(1, item.product.stock)}
                            defaultValue={item.quantity}
                            className="h-8 w-16 text-right"
                          />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            className="h-8 rounded-lg px-3 text-xs"
                          >
                            {tr('cart.update')}
                          </Button>
                        </form>
                      ) : (
                        <span className="text-sm">{item.quantity}</span>
                      )}
                    </div>
                    <p className="text-right text-base font-medium tabular-nums">
                      {money(item.total, item.product.currency, props.locale)}
                    </p>
                  </div>
                </div>
              ))}
            </section>

            <aside className="rounded-[22px] border-4 border-border bg-card p-6 lg:sticky lg:top-24">
              <div className="flex items-center justify-between border-b-4 border-border pb-4">
                <span className="text-sm text-muted-foreground">{tr('cart.total')}</span>
                <span className="text-2xl font-medium tabular-nums">
                  {money(cart?.total ?? 0, items[0]?.product.currency ?? 'CNY', props.locale)}
                </span>
              </div>

              <div className="mt-5 space-y-3">
                {checkoutWallet ? (
                  <form action={checkoutWallet}>
                    <ul className="mb-3 space-y-1.5">
                      {items.map((item) => (
                        <li key={item.id} className="flex items-center gap-3 text-xs">
                          <input
                            type="checkbox"
                            name="cartItemIds"
                            value={item.id}
                            defaultChecked
                            className="size-3.5 accent-foreground"
                          />
                          <span className="min-w-0 flex-1 truncate">{item.product.name}</span>
                          <span className="text-muted-foreground">× {item.quantity}</span>
                        </li>
                      ))}
                    </ul>
                    <Button type="submit" className="h-10 w-full rounded-lg">
                      <ShieldCheck className="size-4" aria-hidden="true" />
                      {tr('cart.payWithBalance')}
                    </Button>
                  </form>
                ) : null}

                {checkoutExternal
                  ? methods?.providers?.flatMap((provider) =>
                      provider.methods.map((method) => (
                        <form
                          key={`${provider.id}-${method.id}`}
                          action={checkoutExternal}
                          className="space-y-2 border-t-4 border-border pt-3"
                        >
                          <ul className="space-y-1.5">
                            {items.map((item) => (
                              <li key={item.id} className="flex items-center gap-3 text-xs">
                                <input
                                  type="checkbox"
                                  name="cartItemIds"
                                  value={item.id}
                                  defaultChecked
                                  className="size-3.5 accent-foreground"
                                />
                                <span className="min-w-0 flex-1 truncate">{item.product.name}</span>
                              </li>
                            ))}
                          </ul>
                          <input type="hidden" name="providerId" value={provider.id} />
                          <input type="hidden" name="paymentMethod" value={method.id} />
                          <Button
                            type="submit"
                            variant="outline"
                            className="h-10 w-full rounded-lg"
                          >
                            {tr('cart.payWith', { method: method.label })}
                          </Button>
                        </form>
                      )),
                    )
                  : null}
              </div>

              <p className="mt-5 flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {tr('cart.secure')}
              </p>
            </aside>
          </div>
        ) : (
          <div className="mt-10 flex flex-col items-start rounded-[20px] border-4 border-border bg-background p-10">
            <ShoppingBag className="size-6 text-muted-foreground" aria-hidden="true" />
            <p className="mt-4 text-sm text-muted-foreground">{tr('cart.empty')}</p>
            <Button render={<a href="/shop" />} nativeButton={false} className="mt-5 rounded-lg">
              {tr('cart.continue')}
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}

function AtlasNotFoundPage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-4 py-28 text-center sm:px-6">
      <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
        {tr('notFound.code')}
      </span>
      <h1 className="mt-6 max-w-2xl text-4xl font-medium tracking-tight text-balance sm:text-6xl">
        {tr('notFound.title')}
      </h1>
      <p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">{tr('notFound.text')}</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button render={<a href="/" />} nativeButton={false} className="rounded-full">
          {tr('notFound.home')}
        </Button>
        <Button
          render={<a href="/shop" />}
          nativeButton={false}
          variant="outline"
          className="rounded-full"
        >
          {tr('notFound.catalog')}
        </Button>
      </div>
    </main>
  );
}

const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  settingsSchema,
  layouts: { theme: AtlasLayout },
  pages: [
    {
      path: '/',
      component: 'home',
      layout: 'theme',
      data: [],
    },
    {
      path: '/shop',
      component: 'shop',
      layout: 'theme',
      data: [
        { finder: 'catalog.categories', as: 'catalogCategories' },
        {
          finder: 'catalog.products',
          as: 'catalogProducts',
          input: { page: 1, pageSize: PAGE_SIZE, categoryId: '', q: '' },
        },
        { finder: 'store.categories', as: 'storeCategories' },
        { finder: 'store.products', as: 'products', input: { page: 1, pageSize: PAGE_SIZE } },
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
    { path: '/about', component: 'about', layout: 'theme' },
    { path: '/guide', component: 'guide', layout: 'theme' },
    { path: '/guide/:slug', component: 'guidePost', layout: 'theme' },
    { path: '*', component: 'notFound', layout: 'theme' },
  ],
  pageComponents: {
    home: HomePage,
    about: AboutPage,
    guide: GuidePage,
    guidePost: GuidePostPage,
    shop: ShopPage,
    product: ShopProductPage,
    cart: ShopCartPage,
    notFound: AtlasNotFoundPage,
  },
};

export default frontend;
