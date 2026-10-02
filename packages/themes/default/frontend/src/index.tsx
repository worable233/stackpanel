import type { ReactElement } from 'react';
import {
  defineFrontend,
  type FrontendLayoutProps,
  type FrontendPackage,
  type FrontendPageProps,
} from '@stackpanel/sdk';
import {
  AnimatedGradientText,
  AnimatedShinyText,
  DiaTextReveal,
  GlyphMatrix,
  Marquee,
  NumberTicker,
  Particles,
  RainbowButton,
  ShimmerButton,
  TextAnimate,
  WordRotate,
} from '@stackpanel/ui';
import {
  ArrowRight,
  Award,
  Box,
  Building2,
  Check,
  ChevronDown,
  Cloud,
  Database,
  Gift,
  HardDrive,
  Menu,
  Network,
  Rocket,
  Server,
  ShieldCheck,
  Zap,
} from 'lucide-react';

const BLOG_POSTS = [
  {
    slug: 'first-cloud',
    title: '怎么选一台合适的云服务器',
    excerpt: 'CPU、内存、带宽、线路……按业务规模挑，不花一分冤枉钱。',
    body: '选型是上云的第一步。轻型网站、开发测试，2核4G 就能流畅起步；业务增长后平滑升配，按月按年灵活结算。把需求讲清楚，我们帮你评估用量，不为用不上的资源付费。',
  },
  {
    slug: 'why-us',
    title: '为什么选择我们',
    excerpt: '服务、技术、交付——三个支点，把业务安心放上云端。',
    body: '服务到位、技术自主、交付及时，这三件事我们从第一天起就在做。选择我们，就是选择一个上得去、稳得住、有人管的云。',
  },
];

const settingsSchema = {
  groups: [
    {
      id: 'hero',
      label: '首页首屏',
      fields: [
        { type: 'text', name: 'heroTitle', label: '主标题', default: '你的业务，值得更稳的云' },
        {
          type: 'textarea',
          name: 'heroSubtitle',
          label: '副标题',
          default: '我们相信，稳定不是偶然，而是工程、运维与时间共同沉淀的结果。',
          help: '一句话说明为什么选择我们',
        },
      ],
    },
    {
      id: 'whychoose',
      label: '为什么选择我们',
      fields: [
        { type: 'text', name: 'whyKicker', label: '区块小标', default: '为什么选择我们' },
        { type: 'text', name: 'whyTitle', label: '区块标题', default: '稳定，不是一句口号' },
        {
          type: 'textarea',
          name: 'whyText',
          label: '区块说明',
          default: '我们相信，上云最需要的确定性，不应该建立在运气之上，而应该建立在可以被验证的工程结果之上。',
        },
        { type: 'text', name: 'feature1Title', label: '板块一标题', default: '技术自主' },
        {
          type: 'textarea',
          name: 'feature1Text',
          label: '板块一说明',
          default: '架构自研、资源自持。我们相信，业务的边界应该由你定义，而不是由平台的限制决定。',
        },
        { type: 'text', name: 'feature2Title', label: '板块二标题', default: '全程服务' },
        {
          type: 'textarea',
          name: 'feature2Text',
          label: '板块二说明',
          default: '从选购到运维，每一次沟通都有人回应。我们相信，好的服务不是口号，而是响应速度与解决问题的能力。',
        },
        { type: 'text', name: 'feature3Title', label: '板块三标题', default: '快速交付' },
        {
          type: 'textarea',
          name: 'feature3Text',
          label: '板块三说明',
          default: '下单即开通，升配即生效。我们相信，时间不应该浪费在等待上，而应该投入到业务本身。',
        },
      ],
    },
    {
      id: 'trust',
      label: '信任与数字',
      fields: [
        { type: 'text', name: 'trustKicker', label: '区块小标', default: '用数据说话' },
        { type: 'text', name: 'trustTitle', label: '区块标题', default: '稳定，看得见' },
        { type: 'text', name: 'stat1Value', label: '统计值一', default: '99.9%' },
        { type: 'text', name: 'stat1Label', label: '统计标签一', default: '稳定在线' },
        {
          type: 'text',
          name: 'stat1Desc',
          label: '统计说明一',
          default: '自研架构持续守护每一次请求，我们相信，掉线不应该成为选项。',
        },
        { type: 'text', name: 'stat2Value', label: '统计值二', default: '<5 min' },
        { type: 'text', name: 'stat2Label', label: '统计标签二', default: '响应速度' },
        {
          type: 'text',
          name: 'stat2Desc',
          label: '统计说明二',
          default: '无论何时提出问题，都会得到及时且真实的回应。',
        },
        { type: 'text', name: 'stat3Value', label: '统计值三', default: '7×24' },
        { type: 'text', name: 'stat3Label', label: '统计标签三', default: '全天值守' },
        {
          type: 'text',
          name: 'stat3Desc',
          label: '统计说明三',
          default: '工程师的响应跨越每一个时区，我们相信，问题应该在今天被解决。',
        },
      ],
    },
    {
      id: 'cta',
      label: '行动号召',
      fields: [
        { type: 'text', name: 'ctaTitle', label: '标题', default: '上云，本就可以足够简单' },
        {
          type: 'textarea',
          name: 'ctaText',
          label: '说明',
          default: '从选配到上线，我们让每一步都足够清晰。选好配置、一键部署、即刻上线。',
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
  database: <Database />,
  drive: <HardDrive />,
  menu: <Menu />,
  network: <Network />,
  rocket: <Rocket />,
  server: <Server />,
  shield: <ShieldCheck />,
  bolt: <Zap />,
};

function Icon({ name }: { name: string }): ReactElement {
  return (
    <span
      className="inline-flex size-[1.15em] shrink-0 items-center justify-center [&_svg]:size-full"
      aria-hidden="true"
    >
      {ICONS[name]}
    </span>
  );
}

function BrandMark({
  size = 'md',
  logoUrl,
}: {
  size?: 'md' | 'lg';
  logoUrl?: string | null | undefined;
}): ReactElement {
  const box = size === 'lg' ? 'size-9 rounded-xl' : 'size-8 rounded-lg';
  if (logoUrl) {
    return (
      <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden ${box}`}>
        <img src={logoUrl} alt="" className="size-full object-contain" />
      </span>
    );
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${box} bg-linear-to-br from-primary to-primary/60 text-sm font-bold text-primary-foreground shadow-sm shadow-primary/30`}
    >
      S
    </span>
  );
}

/** 按分类名称关键词匹配 lucide 图标，未命中时用通用图标兜底。 */
function categoryIcon(name: string): string {
  const n = name.toLowerCase();
  if (/(云?服务器|主机|ecs|裸金属|物理机)/.test(n)) return 'server';
  if (/(轻量|应用|建站|wordpress)/.test(n)) return 'cloud';
  if (/(gpu|算力|训练|渲染|推理)/.test(n)) return 'rocket';
  if (/(硬盘|磁盘|块存储|storage)/.test(n)) return 'drive';
  if (/(对象存储|存储|备份|快照|oss)/.test(n)) return 'database';
  if (/(带宽|网络|负载|cdn|加速|线路)/.test(n)) return 'network';
  if (/(高防|安全|防护|ddos|防火墙)/.test(n)) return 'shield';
  if (/(域名|ssl|证书|邮箱|hosting)/.test(n)) return 'box';
  return 'box';
}

function ThemeLayout({
  children,
  navigation,
  isAuthenticated,
  platform,
  categories = [],
  brand,
}: FrontendLayoutProps): ReactElement {
  const navItems = [{ label: '首页', href: '/' }, ...navigation, { label: '说明', href: '/blog' }];
  return (
    <div className="flex min-h-full flex-1 flex-col bg-background" data-theme-layout="default">
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/85 backdrop-blur-md">
        <div className="relative mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <a href="/" className="group flex items-center gap-2.5 font-semibold tracking-tight">
            <BrandMark logoUrl={brand?.logoUrl} />
            <span className="text-[15px] transition-colors group-hover:text-primary">
              {platform.name}
            </span>
          </a>

          <nav className="hidden items-center gap-0.5 md:flex" aria-label="主导航">
            {categories.length > 0 && (
              <div className="group relative">
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-foreground transition-colors hover:text-primary"
                  aria-haspopup="true"
                >
                  云产品
                  <span className="transition-transform duration-200 group-hover:rotate-180">
                    <Icon name="chevron" />
                  </span>
                </button>
                <div className="invisible fixed left-1/2 top-16 z-50 -translate-x-1/2 opacity-0 transition-all duration-200 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
                  <div className="grid w-[44rem] grid-cols-3 gap-6 rounded-2xl border bg-card p-6 shadow-xl shadow-foreground/5">
                    {categories.map((category) => (
                      <div key={category.id}>
                        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                          {category.name}
                        </p>
                        {category.children.length > 0 ? (
                          <ul className="mt-3 space-y-1">
                            {category.children.map((child) => (
                              <li key={child.id}>
                                <a
                                  href={`/shop?categoryId=${child.id}`}
                                  className="group/item flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-muted/60"
                                >
                                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
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
                className="group relative rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground after:absolute after:inset-x-3 after:-bottom-0.5 after:h-0.5 after:origin-center after:scale-x-0 after:rounded-full after:bg-primary after:transition-[scale] after:duration-300 after:ease-out hover:after:scale-x-100"
              >
                {item.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <RainbowButton
              href={isAuthenticated ? '/account' : '/login'}
              size="default"
              className="hidden sm:inline-flex"
            >
              {isAuthenticated ? '控制台' : '登录/注册'}
            </RainbowButton>
            <details className="group relative md:hidden">
              <summary className="flex size-9 list-none cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground [&::-webkit-details-marker]:hidden">
                <Icon name="menu" />
              </summary>
              <nav
                className="absolute right-0 top-11 max-h-[70vh] w-64 overflow-y-auto rounded-xl border bg-card p-1.5 shadow-lg"
                aria-label="移动端导航"
              >
                {categories.length > 0 && (
                  <>
                    <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
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
                <div className="mt-2 border-t border-border/60 pt-1">
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
                <div className="mt-1 space-y-1 border-t border-border/60 pt-1">
                  <a
                    href="/shop"
                    className="flex items-center justify-center rounded-lg bg-foreground px-3 py-2.5 text-sm font-semibold text-background"
                  >
                    浏览服务
                  </a>
                  <a
                    href={isAuthenticated ? '/account' : '/login'}
                    className="flex items-center justify-center rounded-lg border px-3 py-2.5 text-sm font-medium text-foreground"
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

      <footer className="border-t border-border/50 bg-muted/30">
        <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="grid gap-8 md:grid-cols-[1.6fr_1fr_1fr_1.2fr]">
            <div>
              <a href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
                <BrandMark size="lg" logoUrl={brand?.logoUrl} />
                <span>{platform.name}</span>
              </a>
              <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                让上云简单、稳定、可信。即开即用、按需升配、全程有人。
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">导航</p>
              <ul className="mt-3 space-y-2 text-sm">
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
              <ul className="mt-3 space-y-2 text-sm">
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
              <ul className="mt-3 space-y-2 text-sm">
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
          <div className="pointer-events-auto relative z-10 mt-8 flex w-full flex-col justify-between gap-3 md:flex-row md:items-center md:gap-4 lg:gap-8">
            <span className="text-center text-sm leading-tight text-muted-foreground sm:text-left">
              © {new Date().getFullYear()} {platform.name}, Inc.
            </span>
            <div className="hidden flex-col flex-wrap items-center justify-center gap-y-2 text-center text-sm leading-tight text-muted-foreground sm:justify-end sm:text-right md:flex md:flex-row">
              <a href="/about" className="transition-colors hover:text-foreground">
                关于我们
              </a>
              <span className="mx-1.5 hidden md:inline">|</span>
              <a href="/blog" className="transition-colors hover:text-foreground">
                上云指南
              </a>
              <span className="mx-1.5 hidden md:inline">|</span>
              <a href="/shop" className="transition-colors hover:text-foreground">
                浏览服务
              </a>
              <span className="mx-1.5 hidden md:inline">|</span>
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

/** 从统计字符串里拆出可滚动数字与前后缀，例如 "99.9%" -> 99.9 + "%"，"<5 min" -> "<" + 5 + " min"。 */
function StatValue({ raw }: { raw: string }): ReactElement {
  const match = /^([<>≈~]?)(-?\d+(?:\.\d+)?)(.*)$/.exec(raw.trim());
  if (!match) return <>{raw}</>;
  const [, prefix = '', numStr = '0', suffix = ''] = match;
  const hasDecimal = numStr.includes('.');
  return (
    <>
      {prefix}
      <NumberTicker value={Number(numStr)} decimalPlaces={hasDecimal ? 1 : 0} />
      {suffix}
    </>
  );
}

/** 主标题顿号后的金句，只轮换中间单个字（稳/快/省），前后文字固定。 */
const HERO_ROTATE_WORDS = ['稳', '快', '省'];

const REVEAL_COLORS = ['#38bdf8', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef'];

const CAPABILITIES = [
  {
    title: '云服务器',
    desc: '从开通到升配，每一步都足够简单。主流配置现货供应，分钟级交付；当业务增长，计算资源随需而变，无需迁移，无需停机。',
  },
  {
    title: '轻量应用',
    desc: '我们把复杂留给系统，把简单还给你。建站、小程序与开发测试开箱即用，常用软件一键部署，让想法更快落地。',
  },
  {
    title: '存储与备份',
    desc: '数据是业务最重要的资产，值得被认真对待。多副本落盘、快照随时可回滚，让每一次变更都有后悔的余地。',
  },
  {
    title: '网络与安全',
    desc: '在速度与安全之间，我们选择兼得。弹性带宽与线路优化让访问更快，高防节点守住业务的第一道防线。',
  },
];

function HomePage({ settings }: FrontendPageProps): ReactElement {
  const s = settings.hero ?? {};
  const w = settings.whychoose ?? {};
  const t = settings.trust ?? {};
  const c = settings.cta ?? {};
  const features = [
    {
      title: (w.feature1Title as string) || '技术自主',
      text: (w.feature1Text as string) || '',
    },
    {
      title: (w.feature2Title as string) || '全程服务',
      text: (w.feature2Text as string) || '',
    },
    {
      title: (w.feature3Title as string) || '快速交付',
      text: (w.feature3Text as string) || '',
    },
  ];
  const heroTitle = (s.heroTitle as string) || '你的业务，值得更稳的云';
  const [titleLead = '', titlePunch = ''] = heroTitle.split('，');
  const heroRotateWord = HERO_ROTATE_WORDS.find((word) => titlePunch.includes(word));
  const punchPrefix = heroRotateWord ? titlePunch.slice(0, titlePunch.indexOf(heroRotateWord)) : '';
  const punchSuffix = heroRotateWord
    ? titlePunch.slice(titlePunch.indexOf(heroRotateWord) + heroRotateWord.length)
    : '';
  const rotateWords = heroRotateWord
    ? [heroRotateWord, ...HERO_ROTATE_WORDS.filter((word) => word !== heroRotateWord)]
    : [];
  return (
    <main className="flex-1">
      {/* Hero */}
      <section className="relative isolate flex min-h-[calc(100vh-65px)] flex-col overflow-hidden">
        <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
          <GlyphMatrix color="oklch(0.6 0.12 250)" />
        </div>
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col justify-between gap-12 px-4 pb-16 pt-12 sm:px-6 sm:pb-20 lg:flex-row lg:items-end lg:justify-between lg:px-8">
          <div className="max-w-2xl min-w-0 text-left">
            <h1 className="text-4xl font-bold leading-[1.12] tracking-tight sm:text-5xl lg:text-6xl">
              {titleLead ? <>{titleLead}，</> : null}
              {punchPrefix}
              {rotateWords.length > 0 ? (
                <WordRotate words={rotateWords} duration={3000} />
              ) : (
                titlePunch
              )}
              {punchSuffix}
            </h1>
            <TextAnimate
              as="p"
              animation="blurInUp"
              by="character"
              once
              className="mt-6 max-w-xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg"
            >
              {(s.heroSubtitle as string) ||
                '我们相信，稳定不是偶然，而是工程、运维与时间共同沉淀的结果。'}
            </TextAnimate>
          </div>
            <div className="flex flex-col items-center gap-3 min-[390px]:items-end lg:items-end">
              <div className="flex flex-col items-center gap-3 min-[390px]:flex-row min-[390px]:items-start min-[390px]:justify-end lg:justify-end">
                <div className="flex flex-col items-center gap-2 min-[390px]:items-start">
                <ShimmerButton href="/login" className="h-12 px-8 text-sm font-semibold">
                  注册/登录
                </ShimmerButton>
                <p className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 py-1 pl-2.5 pr-3">
                  <Gift className="size-3.5 text-primary" />
                  <AnimatedShinyText shimmerWidth={90} className="text-xs font-medium text-primary">
                    新用户注册享多重好礼
                  </AnimatedShinyText>
                </p>
              </div>
              <ShimmerButton
                href="/shop"
                background="#ffffff"
                shimmerColor="oklch(0.8 0.06 250)"
                className="h-12 px-8 text-sm font-semibold text-black! border-border!"
              >
                浏览服务
              </ShimmerButton>
            </div>
          </div>
        </div>
      </section>

      {/* Tech marquee */}
      <section className="overflow-hidden border-y border-border/40 bg-muted/20">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          <Marquee
            pauseOnHover
            repeat={3}
            aria-hidden="true"
            className="[--duration:55s] [--gap:2.5rem]"
          >
            {[
              '弹性伸缩',
              '负载均衡',
              '高防节点',
              '对象存储',
              '快照备份',
              'CDN 加速',
              '云监控',
              '全球节点',
              '7×24 服务',
            ].map((item) => (
              <span
                key={item}
                className="whitespace-nowrap text-xs font-medium tracking-wide text-muted-foreground"
              >
                {item}
              </span>
            ))}
          </Marquee>
        </div>
      </section>

      {/* Capabilities */}
      <section className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="max-w-2xl">
          <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            <DiaTextReveal text="一个平台，覆盖所有上云场景" colors={REVEAL_COLORS} />
          </h2>
          <TextAnimate
            as="p"
            animation="fadeIn"
            by="character"
            once
            className="mt-3 text-sm leading-6 text-muted-foreground"
          >
            我们相信，好的上云体验不是服务的堆叠，而是计算、网络与安全之间恰到好处的协同。
          </TextAnimate>
        </div>
        <ul className="mt-10 border-t border-border/60">
          {CAPABILITIES.map((cap, index) => (
            <li key={cap.title} className="border-b border-border/60">
              <a
                href="/shop"
                className="group grid grid-cols-[3.5rem_1fr] items-start gap-x-4 gap-y-2 py-6 transition-colors hover:bg-muted/30 sm:grid-cols-[3.5rem_1fr_1.6fr_auto] sm:items-center sm:px-2"
              >
                <span className="font-mono text-sm text-muted-foreground">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="text-base font-semibold tracking-tight sm:text-lg">
                  {cap.title}
                </span>
                <span className="col-span-2 text-sm leading-6 text-muted-foreground sm:col-span-1">
                  {cap.desc}
                </span>
                <span className="hidden items-center gap-1.5 text-sm font-medium text-primary sm:inline-flex sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
                  查看服务
                  <Icon name="arrow" />
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      {/* Why choose us */}
      <section className="border-t border-border/60 bg-muted/30">
        <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-2 lg:items-start lg:px-8">
          <div className="max-w-md">
            <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              <DiaTextReveal
                text={(w.whyTitle as string) || '稳定，不是一句口号'}
                colors={REVEAL_COLORS}
              />
            </h2>
            <TextAnimate
              as="p"
              animation="fadeIn"
              by="character"
              once
              className="mt-4 text-sm leading-6 text-muted-foreground"
            >
              {(w.whyText as string) || '我们相信，上云最需要的确定性，不应该建立在运气之上，而应该建立在可以被验证的工程结果之上。'}
            </TextAnimate>
            <a
              href="/about"
              className="mt-8 inline-flex h-11 items-center gap-2 rounded-xl border bg-background px-5 text-sm font-semibold text-foreground transition-colors hover:bg-muted/60"
            >
              了解详情
              <Icon name="arrow" />
            </a>
          </div>
          <div className="relative rounded-xl">
            <dl className="divide-y divide-border rounded-xl border bg-card shadow-sm">
              {features.map((feature) => (
                <div key={feature.title} className="flex gap-4 p-6">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon name="check" />
                  </span>
                  <div>
                    <dt className="text-base font-semibold tracking-tight">{feature.title}</dt>
                    <dd className="mt-1.5 text-sm leading-6 text-muted-foreground">
                      {feature.text}
                    </dd>
                  </div>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
        <div className="max-w-2xl">
          <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            <DiaTextReveal
              text={(t.trustTitle as string) || '稳定，看得见'}
              colors={REVEAL_COLORS}
            />
          </h2>
        </div>
        <dl className="mt-10 grid gap-px overflow-hidden rounded-xl border bg-border/60 sm:grid-cols-3">
          {(
            [
              [
                (t.stat1Value as string) || '99.9%',
                (t.stat1Label as string) || '稳定在线',
                (t.stat1Desc as string) || '自研架构持续守护每一次请求，我们相信，掉线不应该成为选项。',
              ],
              [
                (t.stat2Value as string) || '<5 min',
                (t.stat2Label as string) || '响应速度',
                (t.stat2Desc as string) || '无论何时提出问题，都会得到及时且真实的回应。',
              ],
              [
                (t.stat3Value as string) || '7×24',
                (t.stat3Label as string) || '全天值守',
                (t.stat3Desc as string) || '工程师的响应跨越每一个时区，我们相信，问题应该在今天被解决。',
              ],
            ] as Array<[string, string, string]>
          ).map(([value, label, desc]) => (
            <div key={label} className="bg-background p-6 sm:p-8">
              <dd className="text-3xl font-bold tracking-tight">
                <StatValue raw={value} />
              </dd>
              <dt className="mt-1 text-sm font-semibold">{label}</dt>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{desc}</p>
            </div>
          ))}
        </dl>
      </section>

      {/* Blog teaser */}
      <section className="border-t border-border/60 bg-muted/30">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
                <DiaTextReveal text="花两分钟，搞懂上云" colors={REVEAL_COLORS} />
              </h2>
              <TextAnimate
                as="p"
                animation="fadeIn"
                by="character"
                once
                className="mt-3 text-sm leading-6 text-muted-foreground"
              >
                我们把选型、部署与避坑的经验，整理成两分钟可以读完的实用内容。
              </TextAnimate>
            </div>
            <a
              href="/blog"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              全部指南
              <Icon name="arrow" />
            </a>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {BLOG_POSTS.map((post) => (
              <a
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="group flex flex-col rounded-xl border bg-card p-6 text-card-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
              >
                <p className="text-base font-semibold tracking-tight group-hover:underline">
                  {post.title}
                </p>
                <p className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">
                  {post.excerpt}
                </p>
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

      {/* CTA band */}
      <section className="relative overflow-hidden">
        <Particles className="absolute inset-0 z-0" quantity={70} ease={90} color="#64748b" />
        <div className="relative z-10 mx-auto flex w-full max-w-4xl flex-col items-center px-4 py-16 text-center sm:px-6 sm:py-20 lg:px-8">
          <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            <AnimatedGradientText colorFrom="var(--foreground)" colorTo="var(--primary)">
              {(c.ctaTitle as string) || '上云，本就可以足够简单'}
            </AnimatedGradientText>
          </h2>
          <TextAnimate
            as="p"
            animation="fadeIn"
            by="character"
            once
            className="mt-3 max-w-md text-sm leading-6 text-muted-foreground"
          >
            {(c.ctaText as string) || '从选配到上线，我们让每一步都足够清晰。选好配置、一键部署、即刻上线。'}
          </TextAnimate>
          <ShimmerButton
            href="/shop"
            background="#ffffff"
            shimmerColor="oklch(0.8 0.06 250)"
            className="mt-8 h-11 px-8 text-sm font-semibold text-black! border-border!"
          >
            {(c.ctaButton as string) || '开始上云'}
            <Icon name="arrow" />
          </ShimmerButton>
        </div>
      </section>
    </main>
  );
}

function AboutPage(_props: FrontendPageProps): ReactElement {
  return (
    <main className="flex-1">
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-60 [background:radial-gradient(40rem_18rem_at_50%_-5%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
          aria-hidden="true"
        />
        <div className="mx-auto grid w-full max-w-7xl items-center gap-10 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-2 lg:px-8">
          <div>
            <h1 className="mt-6 text-balance text-3xl font-bold tracking-tight sm:text-5xl">
              为什么
              <span className="bg-linear-to-r from-primary to-primary/40 bg-clip-text text-transparent">
                选择我们
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-8 text-muted-foreground">
              我们做云服务器分销，只做一件事：让上云简单、稳定、可信。即开即用、按需升配、全程有人，从第一天起就是默认配置。
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href="/shop"
                className="inline-flex h-11 items-center gap-2 rounded-xl bg-foreground px-6 text-sm font-semibold text-background shadow-md shadow-foreground/10 transition-transform hover:scale-[1.02] active:scale-[0.99]"
              >
                浏览服务
                <Icon name="arrow" />
              </a>
              <a
                href="/blog"
                className="inline-flex h-11 items-center gap-2 rounded-xl border bg-background px-6 text-sm font-semibold text-foreground transition-colors hover:bg-muted/70"
              >
                上云指南
              </a>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ['技术自主', '架构自研，路线自己定'],
              ['全程服务', '从选购到运维，始终有人'],
              ['快速交付', '下单即开通，按需升配'],
            ].map(([label, text]) => (
              <div
                key={label}
                className="rounded-2xl border bg-card p-5 text-card-foreground shadow-sm"
              >
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <span className="flex size-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon name="check" />
                  </span>
                  {label}
                </p>
                <p className="mt-2.5 text-sm leading-6 text-muted-foreground">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="border-t border-border/60 bg-muted/30">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">三条底线</p>
            <h2 className="mt-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              我们只做确定的事
            </h2>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {[
              {
                icon: 'server',
                title: '技术自主',
                text: '架构自研，路线自己定。',
              },
              {
                icon: 'shield',
                title: '全程服务',
                text: '从选购到运维，始终有人。',
              },
              {
                icon: 'bolt',
                title: '快速交付',
                text: '下单即开通，不用等。',
              },
            ].map((v) => (
              <div
                key={v.title}
                className="rounded-2xl border bg-card p-6 text-card-foreground shadow-sm"
              >
                <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon name={v.icon} />
                </span>
                <h3 className="mt-5 text-base font-semibold tracking-tight">{v.title}</h3>
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
      <ul className="mt-10 grid gap-4 sm:grid-cols-2">
        {BLOG_POSTS.map((post) => (
          <li key={post.slug}>
            <a
              href={`/blog/${post.slug}`}
              className="group flex h-full flex-col rounded-2xl border bg-card p-6 text-card-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              <p className="text-xs font-medium uppercase tracking-widest text-primary">
                {post.slug === 'first-cloud' ? '选型' : '服务'}
              </p>
              <h2 className="mt-3 text-base font-semibold tracking-tight group-hover:underline">
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
  if (!post) return <ThemeNotFoundPage {...props} />;
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-14 sm:px-6 sm:py-20">
      <a
        href="/blog"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <Icon name="arrow" />
        返回指南
      </a>
      <h1 className="mt-8 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
        {post.title}
      </h1>
      <div className="mt-6 border-t pt-6">
        <p className="text-base leading-8 text-muted-foreground">{post.body}</p>
      </div>
    </main>
  );
}

/**
 * Themed store catalog: the theme owns the visual shell for the store
 * plugin's `/shop` pages while the plugin supplies the data requirements,
 * finders and actions (theme template override).
 */
interface ThemedProduct {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  stock: number;
  originalPrice: number | null;
  discount: number | null;
}

interface ThemedCategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  icon: string | null;
  sortOrder: number;
  productCount: number;
  children: ThemedCategoryNode[];
}

interface ThemedCatalogProduct {
  catalog: {
    id: string;
    categoryIds: string[];
    shelfStatus: string;
    sortOrder: number;
  };
  product: ThemedProduct;
}

function ThemedShopPage(props: FrontendPageProps): ReactElement {
  const products = (props.data.products as ThemedProduct[] | undefined) ?? [];
  const product = props.data.product as ThemedProduct | undefined;
  const isDetail = Boolean(product);
  const list = isDetail ? (product ? [product] : []) : products;

  const categories = (props.data.categories as ThemedCategoryNode[] | undefined) ?? [];
  const catalogResult = props.data.catalogProducts as
    | { products: ThemedCatalogProduct[]; total: number; page: number; pageSize: number; categoryId: string | null }
    | undefined;
  const settings = props.settings as { shop?: { showAllProducts?: boolean } };
  const activeId = isDetail ? undefined : (catalogResult?.categoryId ?? undefined);
  const hasCatalog = categories.length > 0;
  const showAll = settings.shop?.showAllProducts === true;

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
            {isDetail
              ? product?.name
              : activeId
                ? findThemedCategoryName(categories, activeId)
                : '服务目录'}
          </h1>
          {!isDetail ? (
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              挑选心仪的服务，加入购物车或直接结算。
            </p>
          ) : null}
        </div>
        {isDetail ? (
          <a
            href="/shop"
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-foreground px-4 text-sm font-semibold text-background shadow-sm transition-opacity hover:opacity-90"
          >
            返回服务目录
            <Icon name="arrow" />
          </a>
        ) : (
          <a
            href="/shop/cart"
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-foreground px-4 text-sm font-semibold text-background shadow-sm transition-opacity hover:opacity-90"
          >
            <Icon name="cart" />
            购物车
          </a>
        )}
      </div>
      {!isDetail && hasCatalog ? (
        <div className="mt-10 grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <aside className="h-fit rounded-2xl border bg-card p-4 shadow-sm lg:sticky lg:top-20">
            <nav aria-label="商品分类">
              {showAll ? (
                <a
                  href="/shop?showAll=1"
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-muted ${
                    !activeId ? 'bg-muted font-medium' : 'text-muted-foreground'
                  }`}
                >
                  全部分类
                </a>
              ) : null}
              <ul className="mt-1 space-y-0.5">
                {categories.map((node) => (
                  <ThemedCategoryLink key={node.id} node={node} activeId={activeId} />
                ))}
              </ul>
            </nav>
          </aside>
          <section>
            {activeId ? <ThemedCategoryBreadcrumb categories={categories} activeId={activeId} /> : null}
            {renderCatalogProducts(catalogResult)}
          </section>
        </div>
      ) : (
        <>
          {list.length > 0 ? (
            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((item) => (
                <li key={item.id}>
                  <a
                    href={`/shop/${item.id}`}
                    className="group flex h-full flex-col rounded-2xl border bg-card p-6 text-card-foreground shadow-sm transition-all hover:-translate-y-1 hover:border-primary/40 hover:shadow-md"
                  >
                    <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon name="box" />
                    </span>
                    <p className="mt-4 text-base font-semibold tracking-tight group-hover:underline">
                      {item.name}
                    </p>
                    <p className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">
                      {item.description}
                    </p>
                    <p className="mt-5 text-sm font-semibold text-primary">
                      <ThemedPrice item={item} />
                    </p>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-10 flex flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center">
              <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Icon name="box" />
              </span>
              <p className="mt-4 text-sm font-medium">暂无在售服务</p>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function findThemedCategoryName(
  categories: readonly ThemedCategoryNode[],
  activeId: string,
): string {
  const found = findThemedCategoryNode(categories, activeId);
  return found?.name ?? '服务目录';
}

function findThemedCategoryNode(
  nodes: readonly ThemedCategoryNode[],
  activeId: string,
): ThemedCategoryNode | null {
  for (const node of nodes) {
    if (node.id === activeId) return node;
    const viaChild = findThemedCategoryNode(node.children, activeId);
    if (viaChild) return viaChild;
  }
  return null;
}

function findThemedCategoryPath(
  categories: readonly ThemedCategoryNode[],
  activeId: string,
): ThemedCategoryNode[] | null {
  for (const node of categories) {
    if (node.id === activeId) return [node];
    const viaChild = findThemedCategoryPathInTree(node.children, activeId);
    if (viaChild) return [node, ...viaChild];
  }
  return null;
}

function findThemedCategoryPathInTree(
  nodes: readonly ThemedCategoryNode[],
  activeId: string,
): ThemedCategoryNode[] | null {
  for (const node of nodes) {
    if (node.id === activeId) return [node];
    const viaChild = findThemedCategoryPathInTree(node.children, activeId);
    if (viaChild) return [node, ...viaChild];
  }
  return null;
}

function ThemedCategoryLink({
  node,
  activeId,
}: {
  node: ThemedCategoryNode;
  activeId?: string;
}): ReactElement {
  const isActive = activeId === node.id;
  return (
    <li>
      <a
        href={node.id ? `/shop?categoryId=${node.id}` : '/shop'}
        className={`flex items-center justify-between gap-2 rounded-lg py-1.5 pl-3 pr-2 text-sm transition-colors hover:bg-muted ${
          isActive ? 'bg-muted font-medium' : 'text-muted-foreground'
        }`}
      >
        <span className="truncate">{node.icon ? `${node.icon} ` : ''}{node.name}</span>
        {node.productCount > 0 ? (
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs tabular-nums">
            {node.productCount}
          </span>
        ) : null}
      </a>
      {node.children.length ? (
        <ul className="ml-4">
          {node.children.map((child) => (
            <ThemedCategoryLink key={child.id} node={child} activeId={activeId} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ThemedCategoryBreadcrumb({
  categories,
  activeId,
}: {
  categories: readonly ThemedCategoryNode[];
  activeId: string;
}): ReactElement | null {
  const path = findThemedCategoryPath(categories, activeId);
  if (!path) return null;
  return (
    <nav
      aria-label="面包屑"
      className="mb-4 flex flex-wrap items-center gap-1 text-sm text-muted-foreground"
    >
      <a href="/shop" className="hover:text-foreground hover:underline">
        全部服务
      </a>
      {path.map((node) =>
        node.id === activeId ? (
          <span key={node.id} className="flex items-center gap-1">
            <span aria-hidden>/</span>
            <span className="font-medium text-foreground">{node.name}</span>
          </span>
        ) : (
          <span key={node.id} className="flex items-center gap-1">
            <span aria-hidden>/</span>
            <a
              href={`/shop?categoryId=${node.id}`}
              className="hover:text-foreground hover:underline"
            >
              {node.name}
            </a>
          </span>
        ),
      )}
    </nav>
  );
}

function renderCatalogProducts(
  catalogResult:
    | { products: ThemedCatalogProduct[]; total: number; page: number; pageSize: number; categoryId: string | null }
    | undefined,
): ReactElement {
  const entries = catalogResult?.products ?? [];
  if (!entries.length) {
    return (
      <div className="mt-4 flex flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon name="box" />
        </span>
        <p className="mt-4 text-sm font-medium">
          {catalogResult ? '该分类下暂无在售服务' : '请选择一个分类查看服务'}
        </p>
      </div>
    );
  }
  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">共 {catalogResult.total} 件服务</p>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map(({ product: item }) => (
          <li key={item.id}>
            <a
              href={`/shop/${item.id}`}
              className="group flex h-full flex-col rounded-2xl border bg-card p-6 text-card-foreground shadow-sm transition-all hover:-translate-y-1 hover:border-primary/40 hover:shadow-md"
            >
              <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon name="box" />
              </span>
              <p className="mt-4 text-base font-semibold tracking-tight group-hover:underline">
                {item.name}
              </p>
              <p className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">
                {item.description}
              </p>
              <p className="mt-5 text-sm font-semibold text-primary">
                <ThemedPrice item={item} />
              </p>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

/** 商品价格：售价 + 划线原价 + 折扣徽标。 */
function ThemedPrice({ item }: { item: ThemedProduct }): ReactElement {
  const original =
    item.originalPrice != null && item.originalPrice > item.price ? item.originalPrice : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>
        {(item.price / 100).toFixed(2)} {item.currency}
      </span>
      {original != null ? (
        <span className="text-muted-foreground/60 line-through">
          {(original / 100).toFixed(2)} {item.currency}
        </span>
      ) : null}
      {item.discount != null && item.discount > 0 ? (
        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
          {item.discount}% 折扣
        </span>
      ) : null}
    </span>
  );
}

function ThemeNotFoundPage(_props: FrontendPageProps): ReactElement {
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
        <p className="relative select-none bg-linear-to-b from-primary to-primary/20 bg-clip-text font-mono text-8xl font-black tracking-tight text-transparent drop-shadow-[0_0_2rem_color-mix(in_oklch,var(--primary)_35%,transparent)]">
          404
        </p>
        <h1 className="mt-6 text-2xl font-bold tracking-tight">未找到这个页面</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          你访问的地址不存在或已被移动，回到首页继续逛逛吧。
        </p>
        <a
          href="/"
          className="mt-8 inline-flex h-10 items-center gap-2 rounded-xl bg-foreground px-5 text-sm font-semibold text-background shadow-sm transition-opacity hover:opacity-90"
        >
          返回首页
          <Icon name="arrow" />
        </a>
      </div>
    </main>
  );
}

export const frontend: FrontendPackage = defineFrontend({
  settingsSchema,
  layouts: { theme: ThemeLayout },
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
    notFound: ThemeNotFoundPage,
    post: BlogPostPage,
    shop: ThemedShopPage,
  },
  // The theme owns the public shell for the store plugin's shop list page.
  // The plugin keeps supplying the data requirements and actions; the theme
  // only re-skins the rendered output (Halo theme template override equivalent).
  // Product detail (`/shop/:id`) stays on the store plugin's detail page.
  overrides: {
    '/shop': 'shop',
  },
});

export default frontend;
