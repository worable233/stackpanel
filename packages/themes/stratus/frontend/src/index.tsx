import type { ReactElement } from 'react';
import type { FrontendLayoutProps, FrontendPackage, FrontendPageProps } from '@stackpanel/sdk';
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
  Gauge,
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
  {
    slug: 'enterprise-cloud',
    title: '企业上云：从第一步到规模化',
    excerpt: '选型、迁移、治理——一套可落地的路径。',
    tag: '企业上云',
    body: '企业上云不是把服务器搬到线上就结束，而是一次关于效率与治理的升级。从轻量起步、按业务分期迁移，到统一权限、成本与合规治理，每一步都需要路径清晰的规划。我们用十余年运营经验，帮你把云用得明白、用得稳。',
  },
  {
    slug: 'reliability',
    title: '稳定，是一种工程决策',
    excerpt: '高可用不是魔法，是多区域、多副本与自动故障转移的组合。',
    tag: '最佳实践',
    body: '高可用不是一句承诺，而是一系列工程决策的组合：多可用区部署、数据多副本、自动故障检测与切换、可观测性闭环。你看到的是「从没出过事」，背后是我们对每一个环节的反复演练。',
  },
  {
    slug: 'security',
    title: '从网络到数据，安全的上云姿势',
    excerpt: '网络隔离、主机加固、数据加密与合规审计，一样都不能少。',
    tag: '安全合规',
    body: '安全上云不是买一个防火墙就结束。入口侧要网络隔离与 WAF 防护，主机侧要补丁与基线加固，数据侧要加密与备份，事后还要有审计与处置预案。从攻防演练到等保测评，我们把安全当作一项长期工程持续投入。',
  },
  {
    slug: 'cost',
    title: '云成本治理：把钱花在刀刃上',
    excerpt: '预算、标签、弹性伸缩与账单分析，形成成本闭环。',
    tag: '最佳实践',
    body: '上云之后账单为什么还是涨？多半是资源闲置与规格浪费。通过标签管理、弹性伸缩、规格匹配与账单分析四件套，你可以把每一分钱花在真正需要的算力上。我们提供成本体检服务，帮你找出 30% 以上的隐藏浪费。',
  },
];

const settingsSchema = {
  groups: [
    {
      id: 'hero',
      label: '首屏 Hero',
      fields: [
        { type: 'text', name: 'heroKicker', label: '徽标', default: '产业智变 · 云启未来' },
        {
          type: 'text',
          name: 'heroTitleLine',
          label: '主标题',
          default: '值得信赖的企业级云计算平台',
        },
        {
          type: 'textarea',
          name: 'heroSubtitle',
          label: '副标题',
          default:
            '为您提供值得信赖的一站式云计算平台，覆盖计算、存储、网络、安全与 AI 全栈服务，让每一次创新都更快落地。',
          help: '一句话说明定位',
        },
        {
          type: 'text',
          name: 'searchPlaceholder',
          label: '搜索占位符',
          default: '搜索云产品、解决方案及文档',
        },
        {
          type: 'text',
          name: 'hotKeywords',
          label: '热门搜索词（逗号分隔）',
          default: '轻量应用服务器,云服务器,云数据库,SSL证书',
        },
      ],
    },
    {
      id: 'promo',
      label: '大促公告',
      fields: [
        { type: 'text', name: 'promoTag', label: '公告标签', default: '新客特惠' },
        { type: 'text', name: 'promoTitle', label: '公告标题', default: '云服务器新客首月 1 折起' },
        {
          type: 'text',
          name: 'promoDesc',
          label: '公告说明',
          default: '新用户专享礼包，多款热门套餐限时直降',
        },
        { type: 'text', name: 'promoButton', label: '公告按钮', default: '立即选购' },
      ],
    },
    {
      id: 'models',
      label: '全模态大模型',
      fields: [
        { type: 'text', name: 'modelsKicker', label: '区块小标', default: '全模态大模型' },
        { type: 'text', name: 'modelsTitle', label: '区块标题', default: '大模型服务平台' },
        {
          type: 'textarea',
          name: 'modelsText',
          label: '区块说明',
          default: '开箱即用的大模型服务，汇聚主流优质模型，快速获取普惠的模型能力。',
        },
      ],
    },
    {
      id: 'products',
      label: '产品体系',
      fields: [
        { type: 'text', name: 'productsKicker', label: '区块小标', default: '云产品体系' },
        {
          type: 'text',
          name: 'productsTitle',
          label: '区块标题',
          default: '全栈产品体系，助力企业实现云化转型',
        },
        {
          type: 'textarea',
          name: 'productsText',
          label: '区块说明',
          default: '从底层算力到上层应用，覆盖全场景的云产品服务。',
        },
        {
          type: 'text',
          name: 'productsLink',
          label: '更多产品链接文字',
          default: '探索更多云产品',
        },
      ],
    },
    {
      id: 'case',
      label: '客户案例',
      fields: [
        { type: 'text', name: 'caseKicker', label: '区块小标', default: '客户案例' },
        {
          type: 'text',
          name: 'caseTitle',
          label: '区块标题',
          default: '行业领先的解决方案，助力企业安全高效上云',
        },
        { type: 'text', name: 'caseMetric1', label: '案例数字一', default: '10万+' },
        { type: 'text', name: 'caseMetric1Label', label: '案例数字一标签', default: '并发能力' },
        { type: 'text', name: 'caseMetric2', label: '案例数字二', default: '≤300' },
        { type: 'text', name: 'caseMetric2Label', label: '案例数字二标签', default: 'ms 超低延迟' },
      ],
    },
    {
      id: 'infra',
      label: '全球基础设施',
      fields: [
        { type: 'text', name: 'infraKicker', label: '区块小标', default: '全球基础设施' },
        {
          type: 'text',
          name: 'infraTitle',
          label: '区块标题',
          default: '安全合规、高速稳定的基础设施建设',
        },
        { type: 'text', name: 'infraMetric1', label: '数据一', default: '3200+' },
        { type: 'text', name: 'infraMetric1Label', label: '数据一标签', default: '全球加速节点' },
        { type: 'text', name: 'infraMetric2', label: '数据二', default: '66' },
        { type: 'text', name: 'infraMetric2Label', label: '数据二标签', default: '可用区' },
        { type: 'text', name: 'infraMetric3', label: '数据三', default: '22' },
        { type: 'text', name: 'infraMetric3Label', label: '数据三标签', default: '地理区域' },
        { type: 'text', name: 'infraMetric4', label: '数据四', default: '200T' },
        { type: 'text', name: 'infraMetric4Label', label: '数据四标签', default: '带宽储备' },
      ],
    },
    {
      id: 'cta',
      label: '行动号召',
      fields: [
        { type: 'text', name: 'ctaTitle', label: '标题', default: '开启你的上云之旅' },
        {
          type: 'textarea',
          name: 'ctaText',
          label: '说明',
          default: '注册即享新客礼包，专属架构师一对一支持。',
        },
        { type: 'text', name: 'ctaButton', label: '按钮', default: '免费注册' },
        { type: 'text', name: 'ctaAlt', label: '次按钮', default: '查看控制台' },
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
  if (/(云?服务器|主机|ecs|裸金属|物理机|算力)/.test(n)) return 'server';
  if (/(轻量|应用|建站|wordpress|redis|memcached)/.test(n)) return 'gauge';
  if (/(gpu|训练|渲染|推理|ai|大模型)/.test(n)) return 'rocket';
  if (/(硬盘|磁盘|块存储|cbs)/.test(n)) return 'drive';
  if (/(对象存储|存储|备份|快照|oss|cos)/.test(n)) return 'database';
  if (/(带宽|网络|负载|cdn|加速|线路|ddos|防火墙|waf|安全)/.test(n)) return 'shield';
  if (/(域名|ssl|证书|邮箱|hosting)/.test(n)) return 'globe';
  return 'layers';
}

/** Resolve an asset path relative to the active theme's asset root. */
function themeAsset(base: string | undefined, path: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/${path}`;
}

const COMPLIANCE_BADGES = [
  '等保三级',
  'ISO 27001',
  'CSA STAR',
  '可信云认证',
  'PCI DSS',
  'SOC 鉴证审计',
];

/** Shared enterprise layout: topbar, search header, mega nav, rich footer. */
function StratusLayout({
  children,
  navigation,
  isAuthenticated,
  platform,
  categories = [],
  brand,
  assetsBaseUrl,
}: FrontendLayoutProps): ReactElement {
  const asset = (path: string): string | null => themeAsset(assetsBaseUrl, `img/${path}`);
  const primaryNav = [
    { label: '首页', href: '/' },
    ...navigation,
    { label: '解决方案', href: '/about' },
    { label: '上云指南', href: '/blog' },
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
              7×24 服务热线：400-888-8888
            </span>
            <span className="hidden items-center gap-1.5 sm:flex">
              <Icon name="headset" />
              在线客服
            </span>
            <span className="hidden items-center gap-1.5 md:flex">
              <Icon name="msg" />
              提交工单
            </span>
          </div>
          <div className="flex items-center gap-4">
            <a href="/blog" className="transition-colors hover:text-white">
              帮助文档
            </a>
            <span className="opacity-30" aria-hidden="true">
              |
            </span>
            <a
              href={isAuthenticated ? '/account' : '/login'}
              className="transition-colors hover:text-white"
            >
              {isAuthenticated ? '控制台' : '登录'}
            </a>
            <span className="opacity-30" aria-hidden="true">
              |
            </span>
            <a
              href={isAuthenticated ? '/account' : '/register'}
              className="transition-colors hover:text-white"
            >
              {isAuthenticated ? '个人中心' : '免费注册'}
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
              <span className="sr-only">搜索</span>
            </label>
            <input
              type="search"
              name="q"
              placeholder="搜索云产品、解决方案及文档"
              className="h-10 min-w-0 flex-1 bg-transparent px-2.5 text-sm text-ink outline-none placeholder:text-ink-faint"
            />
            <button
              type="submit"
              className="m-1 inline-flex shrink-0 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              搜索
            </button>
          </form>

          <div className="flex items-center gap-2">
            <a
              href="/shop/cart"
              className="inline-flex size-9 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-muted hover:text-primary"
              aria-label="购物车"
            >
              <Icon name="cart" />
            </a>
            <a
              href={isAuthenticated ? '/account' : '/login'}
              className="hidden items-center rounded-md px-2.5 py-1.5 text-sm text-ink-soft transition-colors hover:text-ink sm:inline-flex"
            >
              {isAuthenticated ? '控制台' : '登录'}
            </a>
            <a
              href={isAuthenticated ? '/account' : '/register'}
              className="hidden items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:inline-flex"
            >
              免费注册
            </a>
            <details className="group relative lg:hidden">
              <summary className="flex size-9 list-none cursor-pointer items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-muted hover:text-primary [&::-webkit-details-marker]:hidden">
                <Icon name="menu" />
              </summary>
              <nav
                className="absolute right-0 top-11 max-h-[75vh] w-80 overflow-y-auto rounded-md border border-border bg-card p-2 shadow-lg"
                aria-label="移动端导航"
              >
                {categories.length > 0 && (
                  <>
                    <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-widest text-ink-faint">
                      云产品
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
                            查看分类
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
      <nav className="hidden border-b border-border bg-card lg:block" aria-label="主导航">
        <div className="mx-auto flex h-11 w-full max-w-[1680px] items-center px-4 sm:px-6 lg:px-12">
          {categories.length > 0 && (
            <div className="group relative mr-6 flex h-full items-center">
              <a
                href="/shop"
                className="flex h-full items-center gap-1 px-1 text-sm font-medium text-primary transition-colors hover:text-primary"
              >
                <Icon name="cloud" />
                全部产品
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
              <p className="mt-4 text-sm leading-6 text-ink-soft">
                值得信赖的一站式云计算平台，覆盖计算、存储、网络、安全与 AI 全栈服务。
              </p>
              <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2">
                {[
                  { label: 'ISO 27001', file: 'cert-iso27001.png' },
                  { label: 'CSA STAR', file: 'cert-csa.png' },
                  { label: 'PCI DSS', file: 'cert-pci.png' },
                  { label: 'SOC 鉴证审计', file: 'cert-soc.png' },
                  { label: 'ISO 22301', file: 'cert-iso22301.png' },
                ].map((cert) => (
                  <span key={cert.label} className="flex items-center gap-1">
                    {asset(cert.file) ? (
                      <img
                        src={asset(cert.file) ?? undefined}
                        alt={cert.label}
                        className="h-7 w-auto"
                      />
                    ) : (
                      <span className="text-primary">
                        <Icon name="check" />
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
              <div>
                <p className="text-sm font-medium text-ink">产品与服务</p>
                <ul className="mt-4 space-y-2.5 text-sm">
                  {['云服务器', '对象存储', '内容分发网络', '云数据库', '云安全'].map((item) => (
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
                <p className="text-sm font-medium text-ink">解决方案</p>
                <ul className="mt-4 space-y-2.5 text-sm">
                  {['金融云', '政务云', '教育云', '游戏云', '电商云'].map((item) => (
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
                <p className="text-sm font-medium text-ink">平台</p>
                <ul className="mt-4 space-y-2.5 text-sm">
                  <li>
                    <a href="/blog" className="text-ink-soft transition-colors hover:text-primary">
                      上云指南
                    </a>
                  </li>
                  <li>
                    <a href="/about" className="text-ink-soft transition-colors hover:text-primary">
                      关于我们
                    </a>
                  </li>
                  <li>
                    <a
                      href="/account"
                      className="text-ink-soft transition-colors hover:text-primary"
                    >
                      控制台
                    </a>
                  </li>
                </ul>
              </div>
            </div>
            <div className="flex flex-col items-start gap-4">
              <p className="text-xs uppercase tracking-widest text-ink-faint">
                7 × 24 小时在线服务
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
                {isAuthenticated ? '进入控制台' : '免费注册'}
              </a>
            </div>
          </div>
          <div className="mt-10 flex flex-col justify-between gap-3 border-t border-border pt-6 text-sm text-ink-faint md:flex-row md:items-center">
            <span>
              © {new Date().getFullYear()} {platform.name}, Inc.
            </span>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <a href="/about" className="transition-colors hover:text-ink">
                法律声明
              </a>
              <a href="/about" className="transition-colors hover:text-ink">
                隐私政策
              </a>
              <a href="/blog" className="transition-colors hover:text-ink">
                帮助文档
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

/** Format an amount of minor units into a readable money string. */
function money(amount: number, currency: string): string {
  const [units, fraction = ''] = Number(amount).toFixed(2).split('.');
  return `${currency === 'CNY' ? '¥' : currency} ${Number(units).toLocaleString('zh-CN')}.${fraction}`;
}

/** Render a product spec table from metadata (key-value), best-effort ordered. */
function specRows(metadata: Record<string, unknown> | null | undefined): Array<[string, string]> {
  if (!metadata) return [];
  const order = [
    'CPU',
    '内存',
    '带宽',
    '流量',
    '系统盘',
    '数据盘',
    '防御',
    '线路',
    '机房',
    '类型',
    '备注',
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
function pricingCard(product: ShopProduct): ReactElement {
  const rows = specRows(product.metadata);
  const priceText = money(product.price, product.currency);
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
          {product.stock > 0 ? '可购' : '缺货'}
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
          <span className="text-xs text-ink-faint">/月起</span>
        </div>
        <span className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm text-ink transition-colors group-hover:border-primary group-hover:bg-primary group-hover:text-primary-foreground">
          立即选购
        </span>
      </div>
    </a>
  );
}

function HomePage(props: FrontendPageProps): ReactElement {
  const s = props.settings.hero ?? {};
  const pr = props.settings.promo ?? {};
  const md = props.settings.models ?? {};
  const p = props.settings.products ?? {};
  const cs = props.settings.case ?? {};
  const inf = props.settings.infra ?? {};
  const c = props.settings.cta ?? {};
  const asset = (path: string): string | null => themeAsset(props.assetsBaseUrl, `img/${path}`);
  const hotKeywords = ((s.hotKeywords as string) || '轻量应用服务器,云服务器,云数据库,SSL证书')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const products = (props.data.catalogProducts as ShopCatalogResult | undefined)?.products ?? [];
  const featured = products.slice(0, 8).map((entry) => entry.product);

  const activities = [
    { icon: 'spark', title: '新用户专享', desc: '首单特惠，多款套餐 1 折起' },
    { icon: 'rocket', title: '秒杀专场', desc: '每日 10 点限量秒杀' },
    { icon: 'star', title: '老客户回馈', desc: '续费优惠，积分兑好礼' },
    { icon: 'msg', title: '专属顾问', desc: '1v1 架构师免费咨询' },
  ];

  const services = [
    { icon: 'server', name: '云服务器', desc: '高性能算力，弹性扩容，分钟级交付' },
    { icon: 'drive', name: '云硬盘', desc: '高可靠块存储，随开随用' },
    { icon: 'database', name: '对象存储', desc: '海量文件存储，按量计费' },
    { icon: 'network', name: '负载均衡', desc: '多活架构，流量自动分发' },
    { icon: 'shield', name: '云安全', desc: 'DDoS 防护，WAF 拦截' },
    { icon: 'globe', name: '域名与证书', desc: '域名注册、SSL、ICP 备案' },
    { icon: 'rocket', name: 'GPU 服务', desc: '即插即用的 GPU 云服务' },
    { icon: 'code', name: 'Serverless', desc: '免运维，按调用计费' },
  ];

  const capabilities = [
    { icon: 'cpu', name: 'AI 算力', desc: 'GPU 云服务器即开即用' },
    { icon: 'rocket', name: '大模型', desc: '训推一体化平台' },
    { icon: 'code', name: '应用开发', desc: '智能体开发框架' },
    { icon: 'database', name: '向量数据库', desc: '千亿级高性能检索' },
    { icon: 'shield', name: '安全', desc: '全链路安全防护' },
    { icon: 'globe', name: '边缘加速', desc: '全球节点触手可达' },
  ];

  const solutions = [
    {
      icon: 'building',
      name: '金融云',
      desc: '高可用、强合规的金融级架构',
      img: 'solution-finance.jpg',
    },
    {
      icon: 'globe',
      name: '电商云',
      desc: '大促高峰弹性扩容，零宕机',
      img: 'solution-ecommerce.jpg',
    },
    { icon: 'rocket', name: '游戏云', desc: '全球低延迟，防 DDoS 攻击', img: 'solution-game.jpg' },
    {
      icon: 'doc',
      name: '政企云',
      desc: '专属集群，本地化合规部署',
      img: 'solution-government.jpg',
    },
    { icon: 'waves', name: '音视频', desc: '低延迟直播与点播解决方案', img: 'solution-media.jpg' },
    {
      icon: 'code',
      name: 'AI 应用',
      desc: '从推理到训练的完整闭环',
      img: 'solution-education.jpg',
    },
  ];

  const customers = [
    '58同城',
    '微众银行',
    '大众点评',
    '滴滴出行',
    '斗鱼',
    '广发证券',
    '快手',
    '迷你世界',
    '蘑菇街',
    '人民日报',
    '人民网',
    '腾讯课堂',
    '腾讯游戏',
    '同程旅游',
    '新东方',
    '永辉超市',
    'Bilibili',
    '绝地求生',
  ];

  const regions = [
    { name: '华北', detail: '北京 9 个可用区' },
    { name: '华东', detail: '上海 9 个可用区' },
    { name: '华南', detail: '广州 6 个、深圳 3 个' },
    { name: '西南', detail: '成都 2 个、重庆 1 个' },
    { name: '中国香港', detail: '3 个可用区' },
    { name: '亚太', detail: '新加坡、东京、首尔' },
    { name: '欧洲', detail: '法兰克福 3 个可用区' },
    { name: '美洲', detail: '硅谷、弗吉尼亚' },
  ];

  return (
    <main className="flex-1">
      {/* Hero */}
      <section className="relative overflow-hidden bg-hero text-hero-foreground">
        <div
          className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(90deg,transparent,#000_10%,#000_90%,transparent)]"
          aria-hidden="true"
        >
          {asset('hero-banner.jpg') && (
            <img
              src={asset('hero-banner.jpg') ?? undefined}
              alt=""
              className="absolute inset-0 size-full object-cover object-center opacity-30"
            />
          )}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_120%_90%_at_50%_-10%,rgba(94,146,255,0.35),transparent_60%)]" />
        </div>
        <div className="relative mx-auto flex w-full max-w-[1680px] items-center px-4 py-16 sm:px-6 sm:py-20 lg:px-12">
          <div className="max-w-[640px]">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium tracking-[0.14em]">
              {(s.heroKicker as string) || '产业智变 · 云启未来'}
            </span>
            <h1 className="mt-5 text-[34px] font-semibold leading-[46px] tracking-tight sm:text-[42px]">
              {(s.heroTitleLine as string) || '值得信赖的企业级云计算平台'}
            </h1>
            <p className="mt-4 max-w-md text-sm leading-[22px] text-hero-foreground/80">
              {(s.heroSubtitle as string) ||
                '为您提供值得信赖的一站式云计算平台，覆盖计算、存储、网络、安全与 AI 全栈服务。'}
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
                <span className="sr-only">搜索</span>
              </span>
              <input
                type="search"
                name="q"
                placeholder="搜索云产品、解决方案及文档"
                className="h-11 min-w-0 flex-1 bg-transparent px-2.5 text-sm text-ink outline-none placeholder:text-ink-faint"
              />
              <button
                type="submit"
                className="inline-flex h-11 shrink-0 items-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                搜索
              </button>
            </form>

            {hotKeywords.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-hero-foreground/70">
                <span className="flex items-center gap-1">
                  <Icon name="bolt" />
                  热门搜索：
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
                { label: 'ISO 27001', file: 'cert-iso27001.png' },
                { label: 'CSA STAR', file: 'cert-csa.png' },
                { label: 'PCI DSS', file: 'cert-pci.png' },
                { label: 'SOC 鉴证审计', file: 'cert-soc.png' },
              ].map((cert) => (
                <span key={cert.label} className="flex items-center gap-1.5">
                  {asset(cert.file) ? (
                    <img
                      src={asset(cert.file) ?? undefined}
                      alt={cert.label}
                      className="h-10 w-auto"
                    />
                  ) : (
                    <span className="text-white">
                      <Icon name="check" />
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>

          <div className="relative ml-auto hidden max-w-[520px] flex-1 lg:block">
            <div className="rounded-lg border border-white/20 bg-card p-6 shadow-xl">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-ink">AI 算力中心</p>
                <span className="rounded-md bg-accent px-2 py-0.5 text-[11px] text-accent-foreground">
                  弹性扩容
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
              {(pr.promoTag as string) || '新客特惠'}
            </span>
            <p className="min-w-0 truncate text-sm text-ink-soft">
              <span className="font-medium text-ink">
                {(pr.promoTitle as string) || '云服务器新客首月 1 折起'}
              </span>
              {pr.promoDesc ? (
                <span className="ml-2 hidden text-ink-faint sm:inline">{pr.promoDesc}</span>
              ) : null}
            </p>
            <a
              href="/shop"
              className="group ml-auto flex shrink-0 items-center gap-0.5 text-sm font-medium text-primary hover:opacity-80"
            >
              {(pr.promoButton as string) || '立即选购'}
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
                {(p.productsKicker as string) || '云产品体系'}
              </p>
              <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
                {(p.productsTitle as string) || '全栈产品体系，助力企业实现云化转型'}
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-ink-soft">
                {(p.productsText as string) || '从底层算力到上层应用，覆盖全场景的云产品服务。'}
              </p>
            </div>
            <a
              href="/shop"
              className="group inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-ink hover:text-primary"
            >
              {(p.productsLink as string) || '探索更多云产品'}
              <span className="transition-transform group-hover:translate-x-0.5">
                <Icon name="arrow" />
              </span>
            </a>
          </div>
          {featured.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {featured.map((product) => pricingCard(product))}
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
              {(md.modelsKicker as string) || '全模态大模型'}
            </p>
            <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              {(md.modelsTitle as string) || '大模型服务平台'}
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-ink-soft">
              {(md.modelsText as string) ||
                '开箱即用的大模型服务，汇聚主流优质模型，快速获取普惠的模型能力。'}
            </p>
            <div className="mt-6 flex items-center justify-center gap-3 text-sm">
              <a
                href="/shop"
                className="inline-flex h-10 items-center rounded-md bg-primary px-6 font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                立即体验
              </a>
              <a
                href="/shop"
                className="inline-flex h-10 items-center rounded-md border border-border px-6 text-ink transition-colors hover:border-primary/40 hover:text-primary"
              >
                查看详情
              </a>
            </div>
          </div>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                name: '混元大模型',
                tag: '文本生成 / 深度思考',
                note: '基于真实业务场景打磨，兼具效果和性价比',
              },
              { name: 'GLM-5.3', tag: '文本生成 / 深度思考', note: '支持 1M 上下文及思考长度控制' },
              {
                name: 'DeepSeek-V4',
                tag: '极速百万长文本',
                note: '专为高并发与低延迟设计的生产级选择',
              },
              {
                name: 'MiniMax-M3',
                tag: '超长上下文 / 原生多模态',
                note: '在编程与智能体任务上达到前沿能力',
              },
              { name: 'Kimi-K3', tag: '多模态理解', note: '1M token 上下文，综合智能领先' },
              { name: '腾讯优图', tag: '视觉理解 / 图像生成', note: '行业领先的视觉模型能力' },
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
            <p className="text-xs leading-5 text-ink-faint">解决方案</p>
            <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              面向行业的成熟云解决方案
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-ink-soft">
              为不同行业量身打造，兼顾性能、成本与合规，让业务更专注。
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {solutions.map((item) => (
              <a
                key={item.name}
                href="/about"
                className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
              >
                <div className="relative h-32 overflow-hidden">
                  {asset(item.img) && (
                    <img
                      src={asset(item.img) ?? undefined}
                      alt=""
                      className="absolute inset-0 size-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-background to-transparent" />
                </div>
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
              {(cs.caseKicker as string) || '客户案例'}
            </p>
            <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              {(cs.caseTitle as string) || '行业领先的解决方案，助力企业安全高效上云'}
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
                    <p className="text-lg font-medium text-ink">实时音视频 · 直播平台案例</p>
                    <p className="mt-1 text-sm text-ink-faint">
                      为直播平台打造新一代高可靠直播架构
                    </p>
                  </div>
                </div>
                <span className="hidden rounded-md bg-accent px-2.5 py-1 text-xs text-accent-foreground sm:block">
                  音视频通信
                </span>
              </div>
              <div className="mt-8 flex items-center gap-12">
                <div>
                  <p className="text-[36px] font-semibold leading-[44px] tracking-tight text-ink">
                    {(cs.caseMetric1 as string) || '10万+'}
                  </p>
                  <p className="mt-1 text-xs text-ink-faint">
                    {(cs.caseMetric1Label as string) || '并发能力'}
                  </p>
                </div>
                <div>
                  <p className="text-[36px] font-semibold leading-[44px] tracking-tight text-ink">
                    {(cs.caseMetric2 as string) || '≤300'}
                  </p>
                  <p className="mt-1 text-xs text-ink-faint">
                    {(cs.caseMetric2Label as string) || 'ms 超低延迟'}
                  </p>
                </div>
              </div>
            </div>
            <div className="overflow-hidden border-y border-border py-6 [mask-image:linear-gradient(to_right,transparent,#000_10%,#000_90%,transparent)]">
              <div className="flex w-max gap-10 animate-marquee">
                {[...customers, ...customers].map((name, index) => (
                  <span
                    key={`${name}-${index}`}
                    className="flex shrink-0 items-center gap-1.5 text-sm text-ink-faint"
                  >
                    <span className="size-1 rounded-full bg-ink-faint" />
                    {name}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Infra */}
      <section className="relative overflow-hidden border-t border-border bg-surface">
        {asset('infra-map.png') && (
          <img
            src={asset('infra-map.png') ?? undefined}
            alt=""
            className="pointer-events-none absolute right-0 top-1/2 hidden h-[110%] -translate-y-1/2 object-contain opacity-15 lg:block"
          />
        )}
        <div className="mx-auto w-full max-w-[1680px] px-4 py-16 sm:px-6 lg:px-12">
          <div className="mb-10">
            <p className="text-xs leading-5 text-ink-faint">
              {(inf.infraKicker as string) || '全球基础设施'}
            </p>
            <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              {(inf.infraTitle as string) || '安全合规、高速稳定的基础设施建设'}
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-12">
            {[
              {
                value: (inf.infraMetric1 as string) || '3200+',
                label: (inf.infraMetric1Label as string) || '全球加速节点',
              },
              {
                value: (inf.infraMetric2 as string) || '66',
                label: (inf.infraMetric2Label as string) || '可用区',
              },
              {
                value: (inf.infraMetric3 as string) || '22',
                label: (inf.infraMetric3Label as string) || '地理区域',
              },
              {
                value: (inf.infraMetric4 as string) || '200T',
                label: (inf.infraMetric4Label as string) || '带宽储备',
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
              已覆盖 8 大区 · 多可用区容灾
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
                权威认证
              </span>
              {[
                { label: 'ISO 27001', file: 'cert-iso27001.png' },
                { label: 'CSA STAR', file: 'cert-csa.png' },
                { label: 'PCI DSS', file: 'cert-pci.png' },
                { label: 'SOC 鉴证审计', file: 'cert-soc.png' },
                { label: 'ISO 22301', file: 'cert-iso22301.png' },
              ].map((cert) => (
                <span key={cert.label} className="flex items-center gap-1.5 text-xs text-ink-soft">
                  {asset(cert.file) ? (
                    <img
                      src={asset(cert.file) ?? undefined}
                      alt={cert.label}
                      className="h-8 w-auto"
                    />
                  ) : (
                    <span className="text-primary">
                      <Icon name="check" />
                    </span>
                  )}
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
              <p className="text-xs leading-5 text-ink-faint">开发者社区</p>
              <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
                完备开发者生态，伴你共同成长
              </h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-ink-soft">
                文档、工具、社区与认证体系，从入门到精通，走上云之路即刻开始。
              </p>
              <a
                href="/blog"
                className="group mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:text-primary"
              >
                前往开发者社区
                <span className="transition-transform group-hover:translate-x-0.5">
                  <Icon name="arrow" />
                </span>
              </a>
              <div className="mt-10 flex items-center gap-6">
                <div>
                  <p className="text-[36px] font-semibold leading-[44px] tracking-tight text-ink">
                    60+
                  </p>
                  <p className="text-xs text-ink-faint">产品免费试用</p>
                </div>
                <div className="h-8 w-px bg-border" />
                <div>
                  <p className="text-[36px] font-semibold leading-[44px] tracking-tight text-ink">
                    7×24
                  </p>
                  <p className="text-xs text-ink-faint">小时在线支持</p>
                </div>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                { icon: 'doc', title: '产品文档', desc: '覆盖全产品的开发文档与应用指南' },
                { icon: 'code', title: '快速上手', desc: '一步步带你完成首次上云部署' },
                { icon: 'msg', title: '技术问答', desc: '社区互助，随时解答开发疑问' },
                { icon: 'star', title: '最佳实践', desc: '来自一线团队的架构实践沉淀' },
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
              <p className="text-xs leading-5 text-ink-faint">上云指南</p>
              <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
                云上资讯，持续更新
              </h2>
            </div>
            <a
              href="/blog"
              className="group inline-flex items-center gap-1.5 text-sm font-medium text-ink hover:text-primary"
            >
              查看全部
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
                    {post.tag}
                  </span>
                  <time className="text-ink-faint">2025</time>
                </div>
                <p className="mt-4 text-lg font-medium tracking-tight text-ink group-hover:text-primary">
                  {post.title}
                </p>
                <p className="mt-2 flex-1 text-sm leading-6 text-ink-faint">{post.excerpt}</p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                  阅读全文
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
            {(c.ctaTitle as string) || '开启你的上云之旅'}
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-hero-foreground/80">
            {(c.ctaText as string) || '注册即享新客礼包，专属架构师一对一支持。'}
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="/register"
              className="inline-flex h-11 items-center gap-2 rounded-md bg-primary-foreground px-8 text-sm font-medium text-primary transition-transform hover:scale-[1.02] active:scale-[0.99]"
            >
              {(c.ctaButton as string) || '免费注册'}
              <Icon name="arrow" />
            </a>
            <a
              href="/login"
              className="inline-flex h-11 items-center rounded-md border border-white/60 px-8 text-sm font-medium transition-colors hover:bg-white/10"
            >
              {(c.ctaAlt as string) || '查看控制台'}
            </a>
          </div>
          <div className="mx-auto mt-12 flex max-w-2xl flex-wrap items-center justify-center gap-x-10 gap-y-4 text-xs text-hero-foreground/80">
            {['60+ 产品免费试用', '首购享 5 折起优惠', '新产品抢先体验', '轻松一站式上云'].map(
              (item) => (
                <span key={item} className="flex items-center gap-1.5">
                  <Icon name="check" />
                  {item}
                </span>
              ),
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function AboutPage(_props: FrontendPageProps): ReactElement {
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
            产业智变 · 云启未来
          </p>
          <h1 className="mt-4 text-balance text-[38px] font-semibold leading-[48px] tracking-tight">
            一个值得信赖的云平台
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-[22px] text-hero-foreground/80">
            我们是一站式云计算服务平台，坚持实体运营、资质齐备、技术独立，为企业提供稳定可靠的云基础设施与行业解决方案。
          </p>
          <div className="mx-auto mt-8 flex w-full max-w-[460px] items-center gap-2 rounded-lg border border-white/20 bg-card p-1.5 shadow-lg">
            <span className="pl-3 text-ink-faint">
              <Icon name="search" />
            </span>
            <input
              type="search"
              aria-label="搜索"
              placeholder="搜索云产品、解决方案及文档"
              className="h-9 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            />
            <a
              href="/shop"
              className="inline-flex h-9 shrink-0 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              搜索
            </a>
          </div>
        </div>
      </section>

      <section className="border-t border-border bg-background">
        <div className="mx-auto w-full max-w-[1680px] px-4 py-16 sm:px-6 lg:px-12">
          <div className="mb-8 text-center">
            <p className="text-xs leading-5 text-ink-faint">我们的底线</p>
            <h2 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              三个确定的承诺
            </h2>
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            {[
              {
                icon: 'building',
                title: '实体运营',
                text: '正规注册，真实经营，合作从头看得清、查得到。',
              },
              {
                icon: 'shield',
                title: '安全合规',
                text: '等级保护三级，合规不是加分项，是默认项。',
              },
              { icon: 'server', title: '技术独立', text: '架构自研、资源自持，路线自己定义。' },
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
            { icon: 'headset', title: '7 × 24 小时服务', text: '工单、电话、专属群，随时响应。' },
            { icon: 'gauge', title: '分钟级交付', text: '从下单到上线，最快分钟级完成。' },
            { icon: 'doc', title: '完整文档', text: '丰富的文档与上手指南，快速起步。' },
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
  activeId?: string;
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
            <p className="text-xs font-medium leading-5 text-ink-faint">商店</p>
            <h1 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              {query ? `搜索结果：${query}` : activeId && active ? active.name : '服务目录'}
            </h1>
            <p className="mt-2 text-sm leading-6 text-ink-faint">
              {active?.description ??
                (query
                  ? `与「${query}」相关的服务共 ${total} 件。`
                  : '挑选心仪的服务，加入购物车或直接结算。')}
            </p>
          </div>
          <a
            href="/shop/cart"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-card px-4 text-sm font-medium text-ink transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground"
          >
            <Icon name="cart" />
            购物车
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
            <span className="sr-only">搜索</span>
          </span>
          <input
            type="search"
            name="q"
            defaultValue={query ?? ''}
            placeholder="搜索云产品"
            className="h-10 min-w-0 flex-1 bg-transparent px-2.5 text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          <button
            type="submit"
            className="m-1 inline-flex shrink-0 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            搜索
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
                  全部服务
                </a>
                {categories.length ? shopCategoryList({ nodes: categories, activeId }) : null}
              </aside>
              <div className="hidden w-px shrink-0 bg-border lg:block" aria-hidden="true" />
              <section className="min-w-0 flex-1 p-4 lg:p-6">
                {activeId && active ? (
                  <nav className="mb-4 flex flex-wrap items-center gap-1 px-2 text-sm text-ink-faint">
                    <a href="/shop" className="transition-colors hover:text-primary">
                      全部服务
                    </a>
                    <span>/</span>
                    <span className="text-ink">
                      {shopCategoryPath(categories, activeId)
                        ?.map((n) => n.name)
                        .join(' / ')}
                    </span>
                  </nav>
                ) : null}
                <p className="mb-4 px-2 text-sm text-ink-faint">共 {total} 件服务</p>
                {entries.length ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {entries.map(({ product }) => pricingCard(product))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-background px-6 py-20 text-center">
                    <span className="flex size-12 items-center justify-center rounded-md bg-muted text-ink-faint">
                      <Icon name="box" />
                    </span>
                    <p className="mt-4 text-sm font-medium text-ink-faint">
                      {query ? '没有找到相关服务，换个关键词试试。' : '该分类下暂无在售服务'}
                    </p>
                  </div>
                )}
                {pages > 1 ? (
                  <nav
                    className="mt-8 flex items-center justify-center gap-2 text-sm"
                    aria-label="分页"
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
  const product = props.data.product as ShopProduct | undefined;
  const methods = props.data.methods as ShopPaymentMethods | undefined;
  const viewer = props.data.viewer as { authenticated: boolean } | undefined;
  if (!product) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center bg-surface px-4 py-24 text-center">
        <p className="text-5xl font-bold text-primary">404</p>
        <p className="mt-4 text-sm text-ink-faint">服务不存在或已下架。</p>
        <a
          href="/shop"
          className="mt-8 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-5 text-sm text-primary-foreground transition-opacity hover:opacity-90"
        >
          返回服务目录
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
  const priceText = money(product.price, product.currency);

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
            返回服务目录
          </a>
          <a
            href="/shop/cart"
            className="inline-flex items-center gap-2 text-sm text-ink-faint transition-colors hover:text-primary"
          >
            <Icon name="cart" />
            购物车
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
                <p className="text-xs font-medium uppercase tracking-widest text-primary">服务</p>
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
            <p className="text-xs font-medium uppercase tracking-widest text-ink-faint">价格</p>
            <p className="mt-2 flex items-baseline gap-1">
              <span className="text-[36px] font-semibold leading-[44px] text-price">
                {priceText}
              </span>
              <span className="text-sm text-ink-faint">元/月起</span>
            </p>
            <p className="mt-4 text-sm text-ink-soft">
              {product.stock > 0 ? `库存 ${product.stock} 件` : '暂时缺货，请稍后再来'}
            </p>
            {product.stock > 0 ? (
              <div className="mt-6 space-y-3 border-t border-border pt-5">
                {addToCart ? (
                  isAuthed ? (
                    <form action={addToCart}>
                      <input type="hidden" name="productId" value={product.id} />
                      <label className="block text-xs text-ink-faint">
                        数量
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
                        加入购物车
                      </button>
                    </form>
                  ) : (
                    <a
                      href={`/login?next=${encodeURIComponent(`/shop/${product.id}`)}`}
                      className="flex h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-card px-4 text-sm text-ink transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground"
                    >
                      <Icon name="cart" />
                      登录后加入购物车
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
                      余额支付
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
          返回服务目录
        </a>
        <div className="mt-4 mb-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-ink-faint">商店</p>
            <h1 className="mt-2 text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
              购物车
            </h1>
            <p className="mt-2 text-sm text-ink-faint">勾选要结算的商品，然后选择支付方式。</p>
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
                          {money(item.product.price, item.product.currency)} / 件
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
                          更新
                        </button>
                      </form>
                    </div>
                  ) : null}
                  <span className="text-lg font-semibold text-price">
                    {money(item.total, item.product.currency)}
                  </span>
                  <div className="flex items-start gap-3">
                    {removeItem ? (
                      <form action={removeItem}>
                        <input type="hidden" name="id" value={item.id} />
                        <button
                          type="submit"
                          className="inline-flex size-9 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-destructive/10 hover:text-destructive"
                          aria-label="移除"
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
                <span className="text-sm text-ink-faint">合计</span>
                <p className="flex items-baseline gap-1">
                  <span className="text-[36px] font-semibold leading-[44px] text-price">
                    {money(cart?.total ?? 0, 'CNY')}
                  </span>
                  <span className="text-sm text-ink-faint">元</span>
                </p>
              </div>
              <div className="mt-6 space-y-3 border-t border-border pt-5">
                <p className="text-sm font-medium text-ink">选择要结算的商品</p>
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
                      余额支付结算
                    </button>
                  </form>
                ) : null}
                {checkoutExternal && hasProviders
                  ? methods.providers.flatMap((provider) =>
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
                            {method.label} 结算
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
              <p className="mt-4 text-sm font-medium text-ink-faint">
                购物车是空的，去挑几件服务吧。
              </p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function BlogPage(_props: FrontendPageProps): ReactElement {
  return (
    <main className="mx-auto w-full max-w-[1000px] flex-1 px-4 py-14 sm:px-6 sm:py-16 lg:px-8">
      <p className="text-xs leading-5 text-ink-faint">上云指南</p>
      <h1 className="mt-2 text-balance text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
        从选型到部署，帮你走好每一步
      </h1>
      <p className="mt-3 max-w-xl text-sm leading-6 text-ink-soft">
        从选型到部署，帮你快速熟悉云服务，走好每一步上云之路。
      </p>
      <ul className="mt-10 grid gap-4 sm:grid-cols-2">
        {BLOG_POSTS.map((post) => (
          <li key={post.slug}>
            <a
              href={`/blog/${post.slug}`}
              className="group flex h-full flex-col rounded-lg border border-border bg-card p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              <p className="text-xs font-medium tracking-widest text-primary">{post.tag}</p>
              <h2 className="mt-3 text-lg font-medium tracking-tight text-ink group-hover:text-primary">
                {post.title}
              </h2>
              <p className="mt-2 flex-1 text-sm leading-6 text-ink-faint">{post.excerpt}</p>
              <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                阅读全文
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
  const post = BLOG_POSTS.find((item) => item.slug === props.params.slug);
  if (!post) return <StratusNotFoundPage {...props} />;
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-14 sm:px-6 sm:py-16">
      <a
        href="/blog"
        className="inline-flex items-center gap-1.5 text-sm text-ink-faint transition-colors hover:text-primary"
      >
        <Icon name="arrow" />
        返回指南
      </a>
      <p className="mt-6 text-xs font-medium uppercase tracking-widest text-primary">{post.tag}</p>
      <h1 className="mt-3 text-balance text-[30px] font-semibold leading-10 tracking-tight text-ink sm:text-[34px]">
        {post.title}
      </h1>
      <div className="mt-6 border-t border-border pt-6">
        <p className="text-base leading-8 text-ink-soft">{post.body}</p>
      </div>
    </main>
  );
}

function StratusNotFoundPage(_props: FrontendPageProps): ReactElement {
  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-surface px-4 py-24">
      <div className="relative mx-auto flex w-full max-w-md flex-col items-center text-center">
        <p className="text-8xl font-bold tracking-tight text-primary">404</p>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-ink">页面不存在</h1>
        <p className="mt-3 text-sm leading-6 text-ink-faint">
          你访问的地址不存在或已被移动，回到首页继续逛逛吧。
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <a
            href="/"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            返回首页
            <Icon name="arrow" />
          </a>
          <a
            href="/shop"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-card px-5 text-sm font-medium text-ink transition-colors hover:border-primary/40 hover:text-primary"
          >
            浏览服务
          </a>
        </div>
      </div>
    </main>
  );
}

export const frontend: FrontendPackage = {
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
