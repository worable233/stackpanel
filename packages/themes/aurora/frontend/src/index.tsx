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

const BLOG_POSTS = [
  {
    slug: 'first-cloud',
    title: '第一次上云，该怎么选服务器',
    excerpt: 'CPU、内存、带宽、线路……按业务规模挑，不花一分冤枉钱。',
    body: '选型是上云的第一步。轻型网站、开发测试，2核4G 就能流畅起步；业务增长后平滑升配，按月按年灵活结算。把需求讲清楚，我们帮你评估用量，不为用不上的资源付费。',
  },
  {
    slug: 'night-sky',
    title: '稳定，是设计出来的',
    excerpt: '从架构到运维，每一步都为「可预期」服务。',
    body: '真实经营、资质齐备、架构自持，这三件事我们从第一天起就做到了。选择我们，就是选择一个看得清、查得到、靠得住的云。',
  },
];

const settingsSchema = {
  groups: [
    {
      id: 'hero',
      label: '首屏',
      fields: [
        { type: 'text', name: 'heroBadge', label: '首屏徽标', default: 'AURORA CLOUD' },
        {
          type: 'text',
          name: 'heroTitle',
          label: '主标题',
          default: '在深空中，找到属于你的云',
        },
        {
          type: 'textarea',
          name: 'heroSubtitle',
          label: '副标题',
          default:
            '暗夜里的一束稳定光。实体运营、资质齐备、架构自主，从第一台服务器开始，可靠就是默认选项。',
          help: '一句话说明为什么选择我们',
        },
      ],
    },
    {
      id: 'why',
      label: '为什么选择我们',
      fields: [
        { type: 'text', name: 'whyKicker', label: '区块小标', default: '为什么选择我们' },
        { type: 'text', name: 'whyTitle', label: '区块标题', default: '稳定，看得见' },
        {
          type: 'textarea',
          name: 'whyText',
          label: '区块说明',
          default: '上云最该有的确定性，我们一次性交付。',
        },
        { type: 'text', name: 'feature1Title', label: '板块一标题', default: '实体企业' },
        {
          type: 'textarea',
          name: 'feature1Text',
          label: '板块一说明',
          default: '正规注册、真实经营，合作从头就看得清、查得到。',
        },
        { type: 'text', name: 'feature2Title', label: '板块二标题', default: '资质齐全' },
        {
          type: 'textarea',
          name: 'feature2Text',
          label: '板块二说明',
          default: '备案与服务资质齐备，合规不是加分项，是默认项。',
        },
        { type: 'text', name: 'feature3Title', label: '板块三标题', default: '技术独立' },
        {
          type: 'textarea',
          name: 'feature3Text',
          label: '板块三说明',
          default: '自研架构、资源自持，升级扩容不设卡，路线自己定。',
        },
      ],
    },
    {
      id: 'stats',
      label: '数据',
      fields: [
        { type: 'text', name: 'statsKicker', label: '区块小标', default: '用数据说话' },
        { type: 'text', name: 'statsTitle', label: '区块标题', default: '稳定，看得见' },
        { type: 'text', name: 'stat1Value', label: '统计值一', default: '99.9%' },
        { type: 'text', name: 'stat1Label', label: '统计标签一', default: '稳定在线' },
        {
          type: 'text',
          name: 'stat1Desc',
          label: '统计说明一',
          default: '自研架构持续守护，掉线不是选项。',
        },
        { type: 'text', name: 'stat2Value', label: '统计值二', default: '<5 min' },
        { type: 'text', name: 'stat2Label', label: '统计标签二', default: '响应速度' },
        {
          type: 'text',
          name: 'stat2Desc',
          label: '统计说明二',
          default: '任何时刻的问题，都有回音。',
        },
        { type: 'text', name: 'stat3Value', label: '统计值三', default: '100%' },
        { type: 'text', name: 'stat3Label', label: '统计标签三', default: '资质合规' },
        {
          type: 'text',
          name: 'stat3Desc',
          label: '统计说明三',
          default: '正规实体，每一单都合规可溯。',
        },
      ],
    },
    {
      id: 'cta',
      label: '行动号召',
      fields: [
        { type: 'text', name: 'ctaTitle', label: '标题', default: '上云，不该是件复杂的事' },
        {
          type: 'textarea',
          name: 'ctaText',
          label: '说明',
          default: '选配置、部署、上线，几步就能跑起来。',
        },
        { type: 'text', name: 'ctaButton', label: '按钮', default: '开始上云' },
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
}: FrontendLayoutProps): ReactElement {
  const navItems = [
    { label: '首页', href: '/' },
    ...navigation,
    { label: '上云指南', href: '/blog' },
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

          <nav className="hidden items-center gap-0.5 lg:flex" aria-label="主导航">
            {categories.length > 0 && (
              <div className="group relative">
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition-colors hover:text-primary"
                  aria-haspopup="true"
                >
                  云产品
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
                                        ? `${child.productCount} 个服务`
                                        : '查看分类'}
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
                            查看分类
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
              {isAuthenticated ? '账户中心' : '登录'}
            </a>
            <a
              href="/shop"
              className="group relative hidden items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition-all hover:shadow-xl hover:shadow-violet-500/30 sm:inline-flex"
            >
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-500 group-hover:translate-x-full" />
              <span className="relative">浏览服务</span>
              <Icon name="arrow" />
            </a>
            <details className="group relative lg:hidden">
              <summary className="flex size-9 list-none cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground [&::-webkit-details-marker]:hidden">
                <Icon name="menu" />
              </summary>
              <nav
                className="absolute right-0 top-11 max-h-[70vh] w-72 overflow-y-auto rounded-2xl border border-white/10 bg-card/95 p-1.5 shadow-2xl shadow-black/40 backdrop-blur-xl"
                aria-label="移动端导航"
              >
                {categories.length > 0 && (
                  <>
                    <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-widest text-primary">
                      云产品
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
                            查看分类
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
                    浏览服务
                  </a>
                  <a
                    href={isAuthenticated ? '/account' : '/login'}
                    className="flex items-center justify-center rounded-lg border border-white/10 px-3 py-2.5 text-sm font-medium text-foreground"
                  >
                    {isAuthenticated ? '账户中心' : '登录'}
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
                让上云简单、稳定、可信。实体运营、资质齐备、架构自主。
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">导航</p>
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
              <p className="text-sm font-semibold text-foreground">关于</p>
              <ul className="mt-4 space-y-2.5 text-sm">
                <li>
                  <a
                    href="/about"
                    className="group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="size-1 -translate-x-1 rounded-full bg-primary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                    关于我们
                  </a>
                </li>
                <li>
                  <a
                    href="/blog"
                    className="group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="size-1 -translate-x-1 rounded-full bg-primary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                    上云指南
                  </a>
                </li>
                <li>
                  <a
                    href="/shop"
                    className="group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="size-1 -translate-x-1 rounded-full bg-primary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                    浏览服务
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">账户</p>
              <ul className="mt-4 space-y-2.5 text-sm">
                <li>
                  <a
                    href={isAuthenticated ? '/account' : '/login'}
                    className="group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="size-1 -translate-x-1 rounded-full bg-primary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                    {isAuthenticated ? '账户中心' : '登录'}
                  </a>
                </li>
                <li>
                  <a
                    href="/account"
                    className="group inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="size-1 -translate-x-1 rounded-full bg-primary opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                    我的订单
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
                关于我们
              </a>
              <span className="mx-1.5">|</span>
              <a href="/blog" className="transition-colors hover:text-foreground">
                上云指南
              </a>
              <span className="mx-1.5">|</span>
              <a href="/shop" className="transition-colors hover:text-foreground">
                浏览服务
              </a>
              <span className="mx-1.5">|</span>
              <a href="/about" className="transition-colors hover:text-foreground">
                隐私政策
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function HomePage({ settings }: FrontendPageProps): ReactElement {
  const s = settings.hero ?? {};
  const w = settings.why ?? {};
  const t = settings.stats ?? {};
  const c = settings.cta ?? {};
  const features = [
    {
      icon: 'building',
      title: (w.feature1Title as string) || '实体企业',
      text: (w.feature1Text as string) || '',
      href: '/about',
      cta: '了解更多',
    },
    {
      icon: 'award',
      title: (w.feature2Title as string) || '资质齐全',
      text: (w.feature2Text as string) || '',
      href: '/about',
      cta: '查看资质',
    },
    {
      icon: 'server',
      title: (w.feature3Title as string) || '技术独立',
      text: (w.feature3Text as string) || '',
      href: '/about',
      cta: '了解架构',
    },
  ];
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
              {(s.heroBadge as string) || 'AURORA CLOUD'}
            </span>
            开始上云
            <Icon name="arrow" />
          </a>
          <h1 className="mt-8 max-w-3xl text-balance bg-gradient-to-br from-cyan-300 via-sky-200 to-violet-300 bg-clip-text text-4xl font-black tracking-tight text-transparent sm:text-6xl">
            {(s.heroTitle as string) || '在深空中，找到属于你的云'}
          </h1>
          <p className="mt-6 max-w-xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg">
            {(s.heroSubtitle as string) ||
              '暗夜里的一束稳定光。实体运营、资质齐备、架构自主，从第一台服务器开始，可靠就是默认选项。'}
          </p>
          <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
            <a
              href="/shop"
              className="group relative inline-flex h-11 items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-7 text-sm font-semibold text-white shadow-xl shadow-sky-500/30 transition-all hover:scale-[1.02] active:scale-[0.99]"
            >
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-500 group-hover:translate-x-full" />
              <span className="relative">浏览服务</span>
              <Icon name="arrow" />
            </a>
            <a
              href="/about"
              className="inline-flex h-11 items-center gap-2 rounded-xl border border-white/10 bg-background/60 px-7 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:bg-muted/50"
            >
              为什么选择我们
            </a>
          </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-gradient-to-r from-cyan-500/5 via-transparent to-violet-500/5 py-10 dark:from-cyan-400/5 dark:via-transparent dark:to-violet-500/5">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <p className="text-center text-xs font-medium uppercase tracking-widest text-muted-foreground">
            一个平台，覆盖所有上云场景
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-12 gap-y-4 text-sm font-semibold text-muted-foreground">
            {['云服务器', '弹性带宽', '数据存储', 'CDN 加速', '高防节点', '计费灵活'].map(
              (name) => (
                <span
                  key={name}
                  className="flex items-center gap-2 opacity-70 transition-opacity hover:opacity-100"
                >
                  <span className="flex size-5 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400/20 to-violet-500/20 text-primary">
                    <Icon name="server" />
                  </span>
                  {name}
                </span>
              ),
            )}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            {(w.whyKicker as string) || '为什么选择我们'}
          </p>
          <h2 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            {(w.whyTitle as string) || '稳定，看得见'}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {(w.whyText as string) || '上云最该有的确定性，我们一次性交付。'}
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
            {(t.statsKicker as string) || '用数据说话'}
          </p>
          <h2 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            {(t.statsTitle as string) || '稳定，看得见'}
          </h2>
        </div>
        <div className="mt-12 grid gap-px overflow-hidden rounded-3xl border border-white/10 bg-white/10 sm:grid-cols-3">
          {[
            [
              (t.stat1Value as string) || '99.9%',
              (t.stat1Label as string) || '稳定在线',
              (t.stat1Desc as string) || '自研架构持续守护，掉线不是选项。',
            ],
            [
              (t.stat2Value as string) || '<5 min',
              (t.stat2Label as string) || '响应速度',
              (t.stat2Desc as string) || '任何时刻的问题，都有回音。',
            ],
            [
              (t.stat3Value as string) || '100%',
              (t.stat3Label as string) || '资质合规',
              (t.stat3Desc as string) || '正规实体，每一单都合规可溯。',
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
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">上云指南</p>
            <h2 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              花两分钟，搞懂上云
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
                  {post.title}
                </p>
                <p className="mt-3 flex-1 text-sm leading-6 text-muted-foreground">
                  {post.excerpt}
                </p>
                <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
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

      <section className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">他们怎么说</p>
          <h2 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            稳定，用户说了算
          </h2>
        </div>
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {[
            {
              quote: '资质、价格、响应，三样都让人放心。业务放这里，很少需要操心。',
              name: '李强',
              role: '初创团队',
            },
            {
              quote: '从选配置到上线，全程有人跟，快到超出预期。',
              name: '周敏',
              role: '电商运营',
            },
            {
              quote: '想升配就升配，想换线路就换线路，没有被绑死的感觉。',
              name: '陈浩',
              role: '独立开发者',
            },
          ].map((item) => (
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
            {(c.ctaTitle as string) || '上云，不该是件复杂的事'}
          </h2>
          <p className="relative mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
            {(c.ctaText as string) || '选配置、部署、上线，几步就能跑起来。'}
          </p>
          <a
            href="/shop"
            className="group relative mt-8 inline-flex h-11 items-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-7 text-sm font-semibold text-white shadow-xl shadow-sky-500/30 transition-transform hover:scale-[1.02] active:scale-[0.99]"
          >
            <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-500 group-hover:translate-x-full" />
            <span className="relative">{(c.ctaButton as string) || '开始上云'}</span>
            <Icon name="arrow" />
          </a>
        </div>
      </section>
    </main>
  );
}

function AboutPage(_props: FrontendPageProps): ReactElement {
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
              关于我们
            </p>
            <h1 className="mt-6 text-balance text-3xl font-bold tracking-tight sm:text-5xl">
              为什么
              <span className="bg-gradient-to-r from-cyan-300 to-violet-300 bg-clip-text text-transparent">
                选择我们
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-8 text-muted-foreground">
              我们做云服务器分销，只做一件事：让上云简单、稳定、可信。实体运营、资质齐备、架构自主，从第一天起就是默认配置。
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="/shop"
                className="inline-flex h-11 items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-6 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition-transform hover:scale-[1.02] active:scale-[0.99]"
              >
                浏览服务
                <Icon name="arrow" />
              </a>
              <a
                href="/blog"
                className="inline-flex h-11 items-center gap-2 rounded-xl border border-white/10 bg-background/60 px-6 text-sm font-semibold text-foreground backdrop-blur transition-colors hover:bg-muted/50"
              >
                上云指南
              </a>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ['实体企业', '正规注册，真实可查'],
              ['资质齐全', '合规不是加分项，是默认项'],
              ['技术独立', '架构自研，路线自己定'],
              ['全程服务', '从选购到运维，始终有人'],
            ].map(([label, text]) => (
              <div
                key={label}
                className="rounded-3xl border border-white/10 bg-card/60 p-6 text-card-foreground shadow-lg shadow-black/5 backdrop-blur"
              >
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <span className="flex size-6 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-400/20 to-violet-500/20 text-primary">
                    <Icon name="check" />
                  </span>
                  {label}
                </p>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-gradient-to-r from-cyan-500/5 via-transparent to-violet-500/5">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">三条底线</p>
            <h2 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              我们只做确定的事
            </h2>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {[
              { icon: 'building', title: '实体企业', text: '真实经营，不玩虚的。' },
              { icon: 'award', title: '资质齐全', text: '合规不是加分项，是默认项。' },
              { icon: 'server', title: '技术独立', text: '架构在自己手里，才谈得上稳定。' },
            ].map((v) => (
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

function BlogPage(_props: FrontendPageProps): ReactElement {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
      <div className="relative">
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-50 [background:radial-gradient(24rem_8rem_at_10%_0%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent)]"
          aria-hidden="true"
        />
        <h1 className="mt-6 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
          云服务上手指南
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
          从选型到部署，帮你快速了解云服务器，开好每一步上云之路。
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
                {post.slug === 'first-cloud' ? '选型' : '理念'}
              </p>
              <h2 className="mt-3 text-base font-semibold tracking-tight group-hover:text-primary">
                {post.title}
              </h2>
              <p className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">{post.excerpt}</p>
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
  if (!post) return <AuroraNotFoundPage {...props} />;
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-14 sm:px-6 sm:py-20">
      <a
        href="/blog"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary"
      >
        <Icon name="arrow" />
        返回指南
      </a>
      <h1 className="mt-8 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
        {post.title}
      </h1>
      <div className="mt-6 border-t border-white/10 pt-6">
        <p className="text-base leading-8 text-muted-foreground">{post.body}</p>
      </div>
    </main>
  );
}

function AuroraNotFoundPage(_props: FrontendPageProps): ReactElement {
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
        <h1 className="mt-6 text-2xl font-bold tracking-tight">迷失在深空里</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          你访问的地址不存在或已被移动，回到首页继续逛逛吧。
        </p>
        <a
          href="/"
          className="mt-8 inline-flex h-10 items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-5 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition-opacity hover:opacity-90"
        >
          返回首页
          <Icon name="arrow" />
        </a>
      </div>
    </main>
  );
}

export const frontend: FrontendPackage = {
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
