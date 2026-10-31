import { formatMinorCurrency } from '@stackpanel/sdk';
import type { FrontendLayoutProps, FrontendPackage, FrontendPageProps } from '@stackpanel/sdk';
import {
  Badge,
  Button,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@stackpanel/ui';
import {
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  Globe2,
  Mail,
  Network,
  Search,
  Server,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { AtlasArticlePage } from './article-page.js';
import { AtlasDataPage } from './data-page.js';
import { AtlasHomePage } from './home-page.js';
import { messages, t } from './i18n.js';
import { safeHref, setting, settingsSchema } from './settings.js';

const INTL_FALLBACK_LOCALE = 'en';
const PAGE_SIZE = 12;
/** Endonyms for the footer language picker; labels live in the package catalog. */
const LOCALE_VALUES = ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'] as const;

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

function PageIntro({
  kicker,
  title,
  lead,
  actions,
}: {
  kicker: string;
  title: string;
  lead?: string;
  actions?: ReactNode;
}): ReactElement {
  return (
    <header>
      <SectionLabel>{kicker}</SectionLabel>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <h1 className="max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl">
          {title}
        </h1>
        {actions}
      </div>
      {lead ? (
        <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">{lead}</p>
      ) : null}
    </header>
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
  platform,
  brand,
  assetsBaseUrl,
  locale,
  settings,
  plugins,
}: FrontendLayoutProps): ReactElement {
  const tr = t(locale);
  const logoUrl = brand?.logoUrl ?? (assetsBaseUrl ? `${assetsBaseUrl}/logo.svg` : undefined);
  const platformName = platform.name || tr('brand.name');
  const brandDisplay = platform.brandDisplay ?? 'both';
  const showBrandIcon = brandDisplay !== 'name';
  const showBrandName = brandDisplay !== 'icon';
  const atlasNav = [
    { label: tr('nav.home'), href: '/' },
    { label: tr('nav.catalog'), href: '/shop' },
    { label: tr('nav.guide'), href: '/guide' },
    { label: tr('nav.about'), href: '/about' },
    ...(plugins?.includes('llm-gateway') ? [{ label: tr('nav.data'), href: '/data' }] : []),
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
          <a href="/" className="flex shrink-0 items-center gap-2.5" aria-label={platformName}>
            {showBrandIcon ? (
              logoUrl ? (
                <img src={logoUrl} alt="" className="size-8 rounded-[10px]" />
              ) : (
                <BrandMark />
              )
            ) : null}
            {showBrandName ? (
              <span className="text-[15px] font-medium tracking-tight">{platformName}</span>
            ) : null}
          </a>

          <nav
            className="ml-4 hidden items-center gap-1 md:flex"
            aria-label={tr('layout.mainNavAria')}
          >
            {nav.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="inline-flex h-10 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Button
              render={<a href="/shop/cart" aria-label={tr('layout.cart')} />}
              nativeButton={false}
              variant="secondary"
              size="icon"
              className="rounded-lg bg-muted"
            >
              <ShoppingBag className="size-4" aria-hidden="true" />
            </Button>
            <Button
              render={<a href={isAuthenticated ? '/account' : '/login'} />}
              nativeButton={false}
              className="hidden h-10 rounded-lg px-5 sm:inline-flex"
            >
              {isAuthenticated ? tr('layout.console') : tr('layout.start')}
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto px-4 py-3 md:hidden">
          <nav className="flex items-center gap-1" aria-label={tr('layout.mainNavAria')}>
            {nav.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="inline-flex h-10 shrink-0 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <div id="main" className="flex flex-1 flex-col">
        {children}
      </div>

      <footer className="bg-background">
        <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
          <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <div>
              <a href="/" className="flex items-center gap-2.5" aria-label={platformName}>
                {showBrandIcon ? (
                  logoUrl ? (
                    <img src={logoUrl} alt="" className="size-8 rounded-[10px]" />
                  ) : (
                    <BrandMark />
                  )
                ) : null}
                {showBrandName ? (
                  <span className="text-[15px] font-medium tracking-tight">{platformName}</span>
                ) : null}
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
              <details className="group/lang relative">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 marker:hidden hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <Globe2 className="size-3.5" aria-hidden="true" />
                  {tr('layout.language')}
                  <ChevronDown
                    className="size-3 transition-transform group-open/lang:rotate-180"
                    aria-hidden="true"
                  />
                </summary>
                <form
                  action="/locale"
                  method="get"
                  className="absolute bottom-full left-0 mb-2 min-w-40 rounded-xl border border-border bg-popover p-1 text-xs shadow-lg"
                >
                  {LOCALE_VALUES.map((value) => (
                    <button
                      key={value}
                      type="submit"
                      name="locale"
                      value={value}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-muted"
                      aria-current={value === locale ? 'true' : undefined}
                    >
                      {tr(`layout.language.${value}`)}
                      {value === locale ? (
                        <Check className="size-3.5 text-primary" aria-hidden="true" />
                      ) : null}
                    </button>
                  ))}
                </form>
              </details>
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
          'group relative flex h-full flex-col gap-0 overflow-hidden rounded-[22px] bg-muted/55 p-0 transition-all duration-300',
          'hover:-translate-y-1',
        )}
      >
        <CardHeader className="flex flex-row items-start justify-between gap-3 p-5 pb-0">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-foreground">
            <ServiceIcon name={product.name} />
          </span>
          <Badge variant={available ? 'secondary' : 'destructive'} className="gap-1.5 px-2 py-1">
            <Boxes className="size-3" aria-hidden="true" />
            {available
              ? tr('home.catalog.stock', { count: String(product.stock) })
              : tr('home.catalog.outOfStock')}
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col p-5 pt-4">
          <CardTitle className="text-base font-medium tracking-tight">
            <a href="/register" className="after:absolute after:inset-0">
              {product.name}
            </a>
          </CardTitle>
          <CardDescription className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
            {product.description ?? tr('product.fallbackDescription')}
          </CardDescription>
          <div className="mt-auto flex items-end justify-between gap-3  pt-4">
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
          <PageIntro
            kicker={tr('about.kicker')}
            title={tr('about.title')}
            lead={tr('about.lead')}
          />
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:py-24">
        <div>
          <div className="rounded-[20px] bg-muted/60 p-8">
            <p className="text-2xl leading-9 font-medium tracking-tight text-balance">
              “{tr('about.quote')}”
            </p>
            <div className="mt-8 flex items-center gap-3  pt-6 text-sm text-muted-foreground">
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
            <div key={index} className="atl-scroll-fade  pt-6">
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
        <PageIntro kicker={tr('guide.kicker')} title={tr('guide.title')} lead={tr('guide.lead')} />

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {GUIDE_POSTS.map((post) => (
            <div key={post.slug} className="atl-scroll-fade h-full">
              <a
                href={`/guide/${post.slug}`}
                className="group flex h-full flex-col rounded-[22px] bg-muted/55 p-6 transition-all hover:-translate-y-1"
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
        <div className="mt-8">
          <SectionLabel>{tr('guide.kicker')}</SectionLabel>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          {tr(`${post.key}.date`)} · {tr('guide.readTime', { minutes: tr(`${post.key}.minutes`) })}
        </p>
        <h1 className="mt-4 text-4xl font-medium tracking-tight text-balance sm:text-5xl">
          {tr(`${post.key}.title`)}
        </h1>
        <p className="mt-5 text-lg leading-8 text-muted-foreground">{tr(`${post.key}.excerpt`)}</p>
        <div className="mt-10 space-y-5  pt-8 text-[15px] leading-8 text-foreground/85">
          {body.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <div className="mt-12 rounded-[20px] bg-muted/60 p-6">
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
  const flat = flattenCategories(categories);
  const query = catalog?.query ?? '';
  const defaultCategory = flat[0]?.id ?? null;
  const activeCategory = catalog?.category?.id ?? (query ? null : defaultCategory);
  const activeNode = flat.find((category) => category.id === activeCategory);
  const activeName =
    catalog?.category?.name ?? activeNode?.name ?? (query ? tr('shop.all') : tr('shop.title'));
  const visibleProducts = activeCategory
    ? products.filter((product) => product.categoryId === activeCategory)
    : products;
  const total =
    (activeCategory ? activeNode?.productCount : catalog?.total) ?? visibleProducts.length;
  const page = catalog?.page ?? 1;
  const pages = Math.max(1, Math.ceil(total / (catalog?.pageSize ?? PAGE_SIZE)));

  return (
    <main className="flex-1">
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
        <PageIntro
          kicker={tr('shop.kicker')}
          title={activeName}
          lead={tr('shop.count', { count: String(total) })}
          actions={
            <Button
              render={<a href="/shop/cart" />}
              nativeButton={false}
              variant="secondary"
              className="h-10 rounded-lg bg-muted px-4 text-foreground hover:bg-muted/80"
            >
              <ShoppingBag className="size-4" aria-hidden="true" />
              {tr('layout.cart')}
            </Button>
          }
        />

        <div className="mt-8 grid gap-6 lg:grid-cols-[220px_1fr]">
          <aside className="flex flex-col gap-4">
            <form action="/shop">
              <div className="flex h-10 items-center gap-2 rounded-[10px] border border-border/80 bg-background px-3 transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/15">
                <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <Input
                  name="q"
                  defaultValue={query}
                  aria-label={tr('shop.searchPlaceholder')}
                  placeholder={tr('shop.searchPlaceholder')}
                  className="h-10 border-0! bg-transparent px-0 text-sm shadow-none focus-visible:border-transparent! focus-visible:ring-0!"
                />
              </div>
              {activeCategory ? (
                <input type="hidden" name="categoryId" value={activeCategory} />
              ) : null}
            </form>

            <nav
              className="flex flex-col gap-0.5 rounded-2xl bg-muted/50 p-2"
              aria-label={tr('shop.filterAria')}
            >
              {flat.map((category) => (
                <a
                  key={category.id}
                  href={shopHref(1, category.id, query || null)}
                  className={cn(
                    'flex h-9 items-center justify-between gap-2 rounded-lg px-3 text-sm transition-colors',
                    activeCategory === category.id
                      ? 'bg-background font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
                  )}
                >
                  <span className="truncate">{category.name}</span>
                  {category.productCount > 0 ? (
                    <span className="text-xs text-muted-foreground">{category.productCount}</span>
                  ) : null}
                </a>
              ))}
            </nav>
          </aside>

          <section className="min-w-0">
            {query ? (
              <p className="mb-4 text-sm text-muted-foreground">
                {tr('shop.resultsFor', { query })}
              </p>
            ) : null}

            {visibleProducts.length > 0 ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {visibleProducts.map((product) => (
                  <ProductCard key={product.id} product={product} locale={props.locale} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-start rounded-[20px] bg-muted/60 p-10">
                <Search className="size-6 text-muted-foreground" aria-hidden="true" />
                <p className="mt-4 text-sm text-muted-foreground">{tr('shop.empty')}</p>
                <Button
                  render={<a href="/shop" />}
                  nativeButton={false}
                  variant="secondary"
                  className="mt-5 rounded-lg bg-background"
                >
                  {tr('shop.clear')}
                </Button>
              </div>
            )}

            {pages > 1 ? (
              <nav
                className="mt-8 flex items-center justify-between pt-2"
                aria-label={tr('shop.paginationAria')}
              >
                <p className="text-sm text-muted-foreground">
                  {page} / {pages}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    render={
                      <a href={shopHref(Math.max(1, page - 1), activeCategory, query || null)} />
                    }
                    nativeButton={false}
                    variant="secondary"
                    size="icon"
                    className="rounded-full bg-muted"
                    aria-label={tr('shop.prev')}
                  >
                    <ChevronLeft className="size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    render={
                      <a
                        href={shopHref(Math.min(pages, page + 1), activeCategory, query || null)}
                      />
                    }
                    nativeButton={false}
                    variant="secondary"
                    size="icon"
                    className="rounded-full bg-muted"
                    aria-label={tr('shop.next')}
                  >
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </nav>
            ) : null}
          </section>
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
        <PageIntro kicker={tr('cart.kicker')} title={tr('cart.title')} lead={tr('cart.lead')} />

        {items.length > 0 ? (
          <div className="mt-10 grid gap-8 lg:grid-cols-[1.5fr_0.75fr] lg:items-start">
            <section className="rounded-[22px] bg-muted/55 p-2">
              <div className="hidden grid-cols-[1fr_130px_120px] gap-4 px-3 py-3 text-xs text-muted-foreground sm:grid">
                <span>{tr('cart.summary')}</span>
                <span>{tr('cart.quantity')}</span>
                <span className="text-right">{tr('cart.total')}</span>
              </div>
              {items.map((item) => (
                <div key={item.id} className="rounded-xl bg-background px-4 py-4">
                  <div className="grid gap-4 sm:grid-cols-[1fr_130px_120px] sm:items-center">
                    <div className="min-w-0">
                      <a href="/register" className="text-sm font-medium hover:underline">
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

            <aside className="rounded-[22px] bg-muted/55 p-6 lg:sticky lg:top-24">
              <div className="flex items-center justify-between rounded-xl bg-background px-4 py-4">
                <span className="text-sm text-muted-foreground">{tr('cart.total')}</span>
                <span className="text-2xl font-medium tabular-nums">
                  {money(cart?.total ?? 0, items[0]?.product.currency ?? 'CNY', props.locale)}
                </span>
              </div>

              <div className="mt-3 space-y-3">
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
                          className="space-y-2  pt-3"
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
          <div className="mt-10 flex flex-col items-start rounded-[20px] bg-muted/60 p-10">
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
  overrides: {
    '/blog/:slug': 'article',
  },
  pages: [
    {
      path: '/',
      component: 'home',
      layout: 'theme',
      data: [
        { finder: 'store.categories', as: 'storeCategories' },
        { finder: 'store.products', as: 'products', input: { page: 1, pageSize: 12 } },
      ],
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
      path: '/shop/cart',
      component: 'cart',
      layout: 'theme',
      data: [
        { finder: 'store.cart', as: 'cart' },
        { finder: 'store.paymentMethods', as: 'methods' },
      ],
    },
    {
      path: '/data',
      component: 'modelData',
      layout: 'theme',
      data: [{ finder: 'llm-gateway.prices', as: 'modelPrices' }],
    },
    { path: '/about', component: 'about', layout: 'theme' },
    { path: '/guide', component: 'guide', layout: 'theme' },
    { path: '/guide/:slug', component: 'guidePost', layout: 'theme' },
    { path: '*', component: 'notFound', layout: 'theme' },
  ],
  pageComponents: {
    home: AtlasHomePage,
    article: AtlasArticlePage,
    modelData: AtlasDataPage,
    about: AboutPage,
    guide: GuidePage,
    guidePost: GuidePostPage,
    shop: ShopPage,
    cart: ShopCartPage,
    notFound: AtlasNotFoundPage,
  },
};

export default frontend;
