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
  Marquee,
  NumberTicker,
  Particles,
  ShimmerButton,
  TextAnimate,
  WordRotate,
} from '@stackpanel/ui';
import { RegionMap, regionStatusLabel, type RegionItem } from './region-map.js';
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
  ShoppingCart,
  Zap,
} from 'lucide-react';

const BLOG_POSTS = [
  {
    slug: 'first-cloud',
    title: '怎么选一台合适的云服务器',
    date: '2026 年 3 月 12 日',
    cover: 0,
    excerpt: 'CPU、内存、带宽、线路……按业务规模挑，不花一分冤枉钱。',
    body: '选型是上云的第一步。轻型网站、开发测试，2核4G 就能流畅起步；业务增长后平滑升配，按月按年灵活结算。把需求讲清楚，我们帮你评估用量，不为用不上的资源付费。',
  },
  {
    slug: 'why-us',
    title: '为什么选择我们',
    date: '2026 年 2 月 20 日',
    cover: 1,
    excerpt: '服务、技术、交付——三个支点，把业务安心放上云端。',
    body: '服务到位、技术自主、交付及时，这三件事我们从第一天起就在做。选择我们，就是选择一个上得去、稳得住、有人管的云。',
  },
  {
    slug: 'deploy-checklist',
    title: '上线的最后一张检查清单',
    date: '2026 年 1 月 8 日',
    cover: 2,
    excerpt: '域名、证书、备份、监控，逐项打勾，让第一次上线不出岔子。',
    body: '上线前把域名解析、证书、备份策略、监控告警逐项确认一遍，能挡掉绝大多数低级故障。清单不长，但每一项都值得认真对待。',
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
          default:
            '我们相信，上云最需要的确定性，不应该建立在运气之上，而应该建立在可以被验证的工程结果之上。',
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
          default:
            '从选购到运维，每一次沟通都有人回应。我们相信，好的服务不是口号，而是响应速度与解决问题的能力。',
        },
        { type: 'text', name: 'feature3Title', label: '板块三标题', default: '快速交付' },
        {
          type: 'textarea',
          name: 'feature3Text',
          label: '板块三说明',
          default:
            '下单即开通，升配即生效。我们相信，时间不应该浪费在等待上，而应该投入到业务本身。',
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
      id: 'regions',
      label: '服务区域',
      fields: [
        { type: 'text', name: 'regionKicker', label: '区块小标', default: '服务区域' },
        {
          type: 'text',
          name: 'regionTitle',
          label: '区块标题',
          default: '一张网络，覆盖你的每一个用户',
        },
        {
          type: 'textarea',
          name: 'regionText',
          label: '区块说明',
          default: '我们把节点部署在离用户最近的地方。标记的每一处，都是真实运行中的服务区域。',
        },
        {
          type: 'list',
          name: 'regionItems',
          label: '区域列表',
          itemLabelField: 'city',
          help: '名称、城市、纬度、经度、状态（online / building / planned）。请填写真实机房信息。',
          default: [],
          fields: [
            { type: 'text', name: 'name', label: '区域名称' },
            { type: 'text', name: 'city', label: '城市' },
            { type: 'number', name: 'lat', label: '纬度', step: 0.0001, default: 0 },
            { type: 'number', name: 'lng', label: '经度', step: 0.0001, default: 0 },
            {
              type: 'select',
              name: 'status',
              label: '状态',
              default: 'online',
              options: [
                { label: '运行中', value: 'online' },
                { label: '建设中', value: 'building' },
                { label: '规划中', value: 'planned' },
              ],
            },
          ],
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
  cart: <ShoppingCart />,
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
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-5 lg:gap-8">
            <a
              href="/"
              className="group flex shrink-0 items-center gap-2.5 font-semibold tracking-tight"
            >
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
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <a
              href={isAuthenticated ? '/account' : '/login'}
              className="hidden h-10 items-center rounded-lg border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted/60 sm:inline-flex"
            >
              {isAuthenticated ? '控制台' : '登录'}
            </a>
            <a
              href="/shop"
              className="hidden h-10 items-center rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 sm:inline-flex"
            >
              免费使用
            </a>
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
      <NumberTicker
        value={Number(numStr)}
        decimalPlaces={hasDecimal ? 1 : 0}
        className="text-inherit"
      />
      {suffix}
    </>
  );
}

/** 主标题顿号后的金句，只轮换中间单个字（稳/快/省），前后文字固定。 */
const HERO_ROTATE_WORDS = ['稳', '快', '省'];

const REVEAL_COLORS = ['#38bdf8', '#2563eb', '#6366f1', '#8b5cf6', '#d946ef'];

/** 云产品矩阵（首屏下方蓝色卡片内部），对齐参考的「能力清单」大色块。 */
const CAPABILITY_CARDS = [
  {
    icon: 'server',
    title: '云服务器',
    desc: '主流配置现货供应，分钟级交付；业务增长随时升配，无需迁移与停机。',
  },
  {
    icon: 'rocket',
    title: '轻量应用',
    desc: '建站、小程序与开发测试开箱即用，常用软件一键部署，让想法更快落地。',
  },
  {
    icon: 'database',
    title: '存储与备份',
    desc: '多副本落盘、快照随时回滚，让每一次变更都有后悔的余地。',
  },
  {
    icon: 'shield',
    title: '网络与安全',
    desc: '弹性带宽与线路优化让访问更快，高防节点守住业务的第一道防线。',
  },
];

const FEATURE_ICONS = ['shield', 'rocket', 'bolt'] as const;

/** Tailwind dot colours per region status (theme frontend forbids inline styles). */
const REGION_DOT_CLASS: Record<string, string> = {
  online: 'bg-emerald-500',
  building: 'bg-amber-500',
  planned: 'bg-slate-400',
};

/** 自绘产品示意卡（无外部图片依赖），用于特性区块的「图」侧。 */
function FeatureMockup({ variant }: { variant: 0 | 1 | 2 }): ReactElement {
  if (variant === 0) {
    return (
      <div className="w-full rounded-2xl border border-white/70 bg-white p-4 shadow-[0_20px_60px_-30px_rgba(15,40,90,0.4)]">
        <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
          <span className="size-2.5 rounded-full bg-slate-200" />
          <span className="size-2.5 rounded-full bg-slate-200" />
          <span className="ml-2 h-4 w-32 rounded bg-slate-100" />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="rounded-lg bg-slate-50 p-3">
              <div className="h-10 rounded-md bg-gradient-to-br from-sky-200 to-indigo-200" />
              <div className="mt-2 h-2.5 w-2/3 rounded bg-slate-200" />
              <div className="mt-1.5 h-2.5 w-1/2 rounded bg-slate-100" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (variant === 1) {
    return (
      <div className="w-full rounded-2xl border border-white/70 bg-white p-4 shadow-[0_20px_60px_-30px_rgba(15,40,90,0.4)]">
        <div className="space-y-3">
          {[80, 55, 92].map((w, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="size-9 shrink-0 rounded-lg bg-primary/10" />
              <div className="flex-1">
                <div className="h-2.5 rounded bg-slate-200" style={{ width: `${w}%` }} />
                <div className="mt-2 h-2.5 w-1/3 rounded bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between rounded-xl bg-primary/5 p-3">
          <div className="h-2.5 w-24 rounded bg-primary/30" />
          <div className="h-7 w-20 rounded-lg bg-primary" />
        </div>
      </div>
    );
  }
  return (
    <div className="w-full rounded-2xl border border-white/70 bg-white p-4 shadow-[0_20px_60px_-30px_rgba(15,40,90,0.4)]">
      <div className="flex items-center justify-between border-b border-slate-100 pb-3">
        <div className="h-3 w-24 rounded bg-slate-200" />
        <div className="flex gap-1.5">
          <span className="size-3 rounded-full bg-emerald-400" />
          <span className="size-3 rounded-full bg-amber-400" />
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {[64, 88, 46, 72].map((w, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-primary" />
            <div className="h-2.5 rounded bg-slate-200" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 自绘文章封面（无外部图片依赖），呼应产品界面质感。 */
function BlogCover({ variant }: { variant: 0 | 1 | 2 }): ReactElement {
  if (variant === 1) {
    return (
      <div className="flex h-full w-full flex-col bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <span className="size-2 rounded-full bg-slate-200" />
          <span className="size-2 rounded-full bg-slate-200" />
          <span className="size-2 rounded-full bg-slate-200" />
          <span className="ml-2 h-4 flex-1 rounded bg-slate-100" />
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="h-6 w-28 rounded-md border border-slate-200 bg-white" />
          <span className="ml-auto h-7 w-16 rounded-md bg-[#009dff]" />
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
          <div className="h-4 w-40 rounded bg-slate-800" />
          <div className="h-2.5 w-56 rounded bg-slate-200" />
          <div className="mt-1 h-7 w-24 rounded-full bg-violet-500/90" />
        </div>
        <div className="grid grid-cols-3 gap-2 px-4 pb-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 rounded-lg bg-slate-50" />
          ))}
        </div>
      </div>
    );
  }
  if (variant === 2) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[#f6f1ea] px-6">
        <span className="text-2xl font-black italic tracking-tight text-orange-500">Creation</span>
        <div className="h-3 w-40 rounded bg-slate-800/80" />
        <div className="h-2.5 w-52 rounded bg-slate-400/50" />
        <div className="mt-2 grid w-full grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 rounded-md bg-white/70" />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="relative h-full w-full overflow-hidden bg-[linear-gradient(135deg,#eef1fb_0%,#f6f3ff_100%)]">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgba(99,102,241,0.14)_1px,transparent_0)] bg-[length:18px_18px]"
      />
      <div className="absolute left-5 top-7 rotate-[-6deg] rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-slate-500 shadow-sm">
        设计模式
      </div>
      <div className="absolute right-7 top-6 rotate-[8deg] rounded-md bg-yellow-300 px-3 py-2 text-xs font-bold text-slate-800 shadow-sm">
        Happy
      </div>
      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-white/85 px-4 py-2 shadow-md">
        <span className="size-6 rounded-full bg-[#009dff]" />
        <span className="text-sm font-semibold text-slate-700">画板</span>
      </div>
      <div className="absolute bottom-6 right-7 rotate-[-4deg] rounded-md bg-violet-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm">
        convert
      </div>
    </div>
  );
}

function HomePage({ settings }: FrontendPageProps): ReactElement {
  const s = settings.hero ?? {};
  const w = settings.whychoose ?? {};
  const t = settings.trust ?? {};
  const c = settings.cta ?? {};
  const rg = settings.regions ?? {};
  const regionItems: RegionItem[] = (Array.isArray(rg.regionItems) ? rg.regionItems : []).map(
    (row) => ({
      name: String(row.name ?? ''),
      city: String(row.city ?? ''),
      lat: Number(row.lat ?? 0),
      lng: Number(row.lng ?? 0),
      status: String(row.status ?? 'online'),
    }),
  );
  const regionStats = [
    {
      value: (rg.regionStat1Value as string) || '多地域',
      label: (rg.regionStat1Label as string) || '服务区域',
    },
    {
      value: (rg.regionStat2Value as string) || '7×24',
      label: (rg.regionStat2Label as string) || '全天值守',
    },
    {
      value: (rg.regionStat3Value as string) || '分钟级',
      label: (rg.regionStat3Label as string) || '开通上线',
    },
  ];
  const features = [
    {
      icon: FEATURE_ICONS[0],
      title: (w.feature1Title as string) || '技术自主',
      text: (w.feature1Text as string) || '',
    },
    {
      icon: FEATURE_ICONS[1],
      title: (w.feature2Title as string) || '全程服务',
      text: (w.feature2Text as string) || '',
    },
    {
      icon: FEATURE_ICONS[2],
      title: (w.feature3Title as string) || '快速交付',
      text: (w.feature3Text as string) || '',
    },
  ];
  const stats = [
    [
      (t.stat1Value as string) || '99.9%',
      (t.stat1Label as string) || '稳定在线',
      (t.stat1Desc as string) || '自研架构持续守护每一次请求，掉线不应该成为选项。',
    ],
    [
      (t.stat2Value as string) || '<5 min',
      (t.stat2Label as string) || '响应速度',
      (t.stat2Desc as string) || '无论何时提出问题，都会得到及时且真实的回应。',
    ],
    [
      (t.stat3Value as string) || '7×24',
      (t.stat3Label as string) || '全天值守',
      (t.stat3Desc as string) || '工程师的响应跨越每一个时区，问题应该在今天被解决。',
    ],
  ] as Array<[string, string, string]>;
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
      {/* Hero — a restrained product-led introduction. */}
      <section className="px-3 pt-3 sm:px-4 sm:pt-4">
        <div className="relative isolate flex min-h-[calc(100vh-5.5rem)] flex-col items-center overflow-hidden rounded-[1.25rem] text-slate-950">
          <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
            <div className="absolute inset-0 bg-[linear-gradient(118deg,_#d8f3ff_0%,_#edf8ff_48%,_#fff6e9_100%)]" />
            <div className="absolute -left-40 -top-32 size-[34rem] rounded-full bg-[radial-gradient(circle,_#a8e3ff_0%,_transparent_66%)] opacity-60" />
            <div className="absolute -right-40 top-24 size-[30rem] rounded-full bg-[radial-gradient(circle,_#fff1c9_0%,_transparent_68%)] opacity-55" />
          </div>
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 pb-10 pt-24 text-center sm:px-6 sm:pt-28">
            <h1 className="text-balance text-4xl font-bold leading-[1.12] tracking-tight text-slate-950 sm:text-5xl lg:text-[3.5rem]">
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
              className="mt-5 max-w-xl text-pretty text-sm leading-6 text-slate-600 sm:text-base"
            >
              {(s.heroSubtitle as string) ||
                '我们相信，稳定不是偶然，而是工程、运维与时间共同沉淀的结果。'}
            </TextAnimate>

            <div className="mt-8 flex w-full max-w-xl flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href="/shop"
                className="inline-flex h-12 w-full items-center justify-center rounded-full bg-primary px-8 text-sm font-semibold text-white shadow-[0_10px_30px_-12px_rgba(0,130,220,0.8)] transition-colors hover:bg-[#0089e0] sm:w-auto"
              >
                开始上云
                <Icon name="arrow" />
              </a>
              <a
                href="/login"
                className="inline-flex h-12 w-full items-center justify-center rounded-full border border-white/80 bg-white/65 px-8 text-sm font-semibold text-slate-700 transition-colors hover:bg-white sm:w-auto"
              >
                登录账户
              </a>
            </div>
            <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-slate-500">
              <Gift className="size-3.5 text-primary" />
              <AnimatedShinyText shimmerWidth={90} className="font-medium text-slate-600">
                新用户注册享多重好礼
              </AnimatedShinyText>
            </p>
            <p className="mt-3 text-xs text-slate-500">
              支持网页端、开放 API、第三方客户端与 Docker / PM2 部署
            </p>
          </div>
        </div>
      </section>

      {/* Tech marquee */}
      <section className="mt-4 overflow-hidden border-y border-border/40 bg-muted/20">
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

      {/* Why choose us — centered heading + card grid (mirrors reference geometry) */}
      <section id="features" className="px-3 pb-2 sm:px-4">
        <div className="mx-auto w-full max-w-7xl">
          <div className="mx-auto max-w-2xl px-2 py-16 text-center sm:py-20">
            <p className="text-[15px] font-bold text-primary">
              {(w.whyKicker as string) || '为什么选择我们'}
            </p>
            <h2 className="mt-3 text-balance text-3xl font-bold leading-[1.15] tracking-tight sm:text-[42px]">
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
              className="mx-auto mt-4 max-w-xl text-[15px] leading-7 text-muted-foreground"
            >
              {(w.whyText as string) ||
                '我们相信，上云最需要的确定性，不应该建立在运气之上，而应该建立在可以被验证的工程结果之上。'}
            </TextAnimate>
          </div>

          {/* Wide feature card — text left, product visual right */}
          <div className="grid overflow-hidden rounded-[22px] bg-card shadow-[0_16px_16px_-16px_rgba(23,25,29,0.2),0_14px_20px_rgba(23,25,29,0.03)] lg:grid-cols-[0.92fr_1.08fr]">
            <div className="flex flex-col justify-center p-10 sm:p-14">
              <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-xl text-primary">
                <Icon name={features[0]?.icon ?? 'shield'} />
              </span>
              <h3 className="mt-6 text-[28px] font-bold leading-tight tracking-tight sm:text-[32px]">
                {features[0]?.title}
              </h3>
              <p className="mt-4 max-w-md text-[15px] leading-7 text-muted-foreground">
                {features[0]?.text}
              </p>
              <a
                href="/shop"
                className="mt-9 inline-flex h-11 w-fit items-center gap-2 rounded-full border-2 border-[#666667] px-5 text-[15px] font-medium text-foreground transition-colors hover:bg-foreground hover:text-background"
              >
                免费体验
                <Icon name="arrow" />
              </a>
            </div>
            <div className="relative flex items-center bg-[linear-gradient(135deg,_#cdeafd_0%,_#dcd9ff_52%,_#fdf0da_100%)] p-8 sm:p-12">
              <FeatureMockup variant={0} />
            </div>
          </div>

          {/* Two-column cards — white feature card + flat azure resource card */}
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <div className="flex flex-col rounded-[22px] bg-card p-10 shadow-[0_16px_16px_-16px_rgba(23,25,29,0.2),0_14px_20px_rgba(23,25,29,0.03)] sm:p-12">
              <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-xl text-primary">
                <Icon name={features[1]?.icon ?? 'rocket'} />
              </span>
              <h3 className="mt-6 text-[26px] font-bold leading-tight tracking-tight">
                {features[1]?.title}
              </h3>
              <p className="mt-4 text-[15px] leading-7 text-muted-foreground">
                {features[1]?.text}
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <a
                  href="/shop"
                  className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  查看详情
                  <Icon name="arrow" />
                </a>
                <a
                  href="/about"
                  className="inline-flex size-10 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                  aria-label="了解更多"
                >
                  <Icon name="arrow" />
                </a>
              </div>
            </div>

            <div className="rounded-[22px] bg-[#39bcf9] p-10 text-white shadow-[0_16px_16px_-16px_rgba(23,25,29,0.2),0_14px_20px_rgba(23,25,29,0.03)] sm:p-12">
              <h3 className="text-[26px] font-bold leading-tight tracking-tight text-slate-950 sm:text-[30px]">
                每一个数字，都来自真实交付
              </h3>
              <p className="mt-3 max-w-md text-[15px] leading-6 text-white/85">
                {features[2]?.title ? `${features[2]?.title}：` : ''}
                {features[2]?.text}
              </p>
              <div className="mt-9 grid grid-cols-3 gap-5">
                {stats.map(([value, label]) => (
                  <div key={label}>
                    <div className="text-[24px] font-medium leading-none text-white">
                      <StatValue raw={value} />
                    </div>
                    <div className="mt-2 text-xs leading-5 text-white/80">{label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Capability matrix — light card grid (keeps the reference's white-card language) */}
      <section className="px-3 py-4 sm:px-4">
        <div className="mx-auto w-full max-w-7xl rounded-[22px] bg-card px-6 py-16 shadow-[0_16px_16px_-16px_rgba(23,25,29,0.2),0_14px_20px_rgba(23,25,29,0.03)] sm:px-12 sm:py-20">
          <div className="max-w-2xl">
            <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">
              一个平台，覆盖所有上云场景
            </h2>
            <p className="mt-4 text-[15px] leading-7 text-muted-foreground">
              好的上云体验不是服务的堆叠，而是计算、网络与安全之间恰到好处的协同。
            </p>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {CAPABILITY_CARDS.map((cap) => (
              <div
                key={cap.title}
                className="rounded-2xl border border-border/70 bg-background/50 p-6 transition-colors hover:border-primary/40"
              >
                <span className="inline-flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon name={cap.icon} />
                </span>
                <h3 className="mt-5 text-base font-semibold">{cap.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{cap.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Service regions — full-bleed dark band (bg #0f161f, no card, no side
          gutters) with a centered chip + gradient heading, then a #1c232e
          content panel holding the self-drawn world map and live counts. Always
          renders; markers appear once regions are configured in settings. */}
      <section className="bg-[#0f161f] px-6 py-24 text-white sm:px-11 sm:py-[111px]">
        <div className="mx-auto w-full max-w-7xl">
          <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
            <span className="inline-flex h-[35px] items-center rounded-full border border-[#009dff]/40 bg-[linear-gradient(135deg,rgba(0,123,255,0.12),rgba(0,179,255,0.12))] px-3 text-[13px] font-medium text-[#009dff]">
              {(rg.regionKicker as string) || '服务区域'}
            </span>
            <h2 className="mt-4 text-balance text-3xl font-black leading-tight tracking-tight sm:text-[42px]">
              <span className="bg-[linear-gradient(-45deg,#fff566,#a8ffca,#ffad61,#ff857a,#ffffff,#ff5cc9,#6279ea,#66ffe6)] bg-clip-text text-transparent">
                {(rg.regionTitle as string) || '一张网络，覆盖你的每一个用户'}
              </span>
            </h2>
            <p className="mt-5 text-[15px] leading-7 text-white/60">
              {(rg.regionText as string) || ''}
            </p>
          </div>

          <div className="relative isolate mt-12 overflow-hidden rounded-[20px] bg-[#1c232e] p-6 sm:p-10">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.05)_1px,transparent_0)] bg-[length:22px_22px]"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-24 right-1/4 -z-10 size-[26rem] rounded-full bg-[#009dff]/10 blur-3xl"
            />
            <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.5fr]">
              <div>
                <div className="flex items-stretch gap-8">
                  {regionStats.map((stat, index) => (
                    <div
                      key={stat.label}
                      className={index > 0 ? 'border-l border-white/10 pl-8' : undefined}
                    >
                      <div className="text-[24px] font-medium leading-none text-white">
                        {stat.value}
                      </div>
                      <div className="mt-2 text-[14px] font-medium text-white">{stat.label}</div>
                    </div>
                  ))}
                </div>

                {regionItems.length > 0 ? (
                  <div className="mt-8 flex flex-wrap gap-4 text-xs text-white/70">
                    {(['online', 'building', 'planned'] as const).map((status) => (
                      <span key={status} className="inline-flex items-center gap-2">
                        <span
                          className={`inline-block size-2.5 rounded-full ${REGION_DOT_CLASS[status]}`}
                        />
                        {regionStatusLabel(status)}
                      </span>
                    ))}
                  </div>
                ) : null}

                <a
                  href="/shop"
                  className="mt-9 inline-flex h-11 w-fit items-center gap-2 rounded-full border border-white/20 px-6 text-[16px] font-medium text-white transition-colors hover:bg-white/10"
                >
                  浏览服务区域
                  <Icon name="arrow" />
                </a>
              </div>

              <div>
                <RegionMap items={regionItems} tone="dark" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Blog teaser — white band, centered heading group + blue button, then a
          three-column card grid (cover 22px radius, 1.81 ratio; date in brand
          blue). Mirrors the reference "快速的产品更新迭代" section. */}
      <section className="bg-white">
        <div className="mx-auto w-full max-w-7xl px-6 py-[76px] sm:px-11">
          <div className="mx-auto flex max-w-2xl flex-col items-center text-center">
            <h2 className="text-balance text-2xl font-bold tracking-tight sm:text-[30px]">
              <DiaTextReveal text="花两分钟，搞懂上云" colors={REVEAL_COLORS} />
            </h2>
            <TextAnimate
              as="p"
              animation="fadeIn"
              by="character"
              once
              className="mt-5 text-[20px] leading-8 text-foreground/80"
            >
              我们把选型、部署与避坑的经验，整理成两分钟可以读完的实用内容。
            </TextAnimate>
            <a
              href="/blog"
              className="mt-8 inline-flex h-[49px] items-center gap-2 rounded-lg bg-primary px-6 text-[15px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              全部指南
              <Icon name="arrow" />
            </a>
          </div>

          <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {BLOG_POSTS.map((post) => (
              <a
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="group flex flex-col text-card-foreground"
              >
                <div className="aspect-[1.81] overflow-hidden rounded-xl border border-border/60 bg-card">
                  <BlogCover variant={post.cover} />
                </div>
                <div className="px-1 pt-5">
                  <span className="text-[13px] font-medium text-primary">{post.date}</span>
                  <h3 className="mt-1.5 text-[15px] font-bold tracking-tight group-hover:text-primary">
                    {post.title}
                  </h3>
                  <p className="mt-3 text-[15px] leading-6 text-muted-foreground">{post.excerpt}</p>
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="relative overflow-hidden">
        <Particles className="absolute inset-0 z-0" quantity={70} ease={90} color="#94a3b8" />
        <div className="relative z-10 mx-auto flex w-full max-w-4xl flex-col items-center px-4 py-20 text-center sm:px-6 sm:py-24 lg:px-8">
          <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">
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
            {(c.ctaText as string) ||
              '从选配到上线，我们让每一步都足够清晰。选好配置、一键部署、即刻上线。'}
          </TextAnimate>
          <ShimmerButton
            href="/shop"
            background="var(--primary)"
            className="mt-8 h-12 px-8 text-sm font-semibold"
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
    | {
        products: ThemedCatalogProduct[];
        total: number;
        page: number;
        pageSize: number;
        categoryId: string | null;
      }
    | undefined;
  const settings = props.settings as { shop?: { showAllProducts?: boolean } };
  const activeId = isDetail ? undefined : (catalogResult?.categoryId ?? undefined);
  const hasCatalog = categories.length > 0;
  const showAll = settings.shop?.showAllProducts === true;

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
      {/* Catalog header — mirrors the theme's aligned sections: a centered
          heading group with a soft azure radial wash and a subtle grid, a
          brand-blue kicker chip, then a full-width white panel below. */}
      <header className="relative overflow-hidden py-4 text-center sm:py-6">
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-60 [background:radial-gradient(38rem_15rem_at_50%_-10%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-0 -z-10 opacity-[0.12] [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:3rem_3rem] [mask-image:radial-gradient(ellipse_60%_55%_at_50%_0%,#000_40%,transparent_100%)]"
          aria-hidden="true"
        />
        <div className="mx-auto flex max-w-2xl flex-col items-center">
          <span className="inline-flex h-[35px] items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3.5 text-[13px] font-medium text-primary">
            <Icon name="box" />
            {isDetail ? '服务详情' : activeId ? '分类浏览' : '服务目录'}
          </span>
          <h1 className="mt-5 text-balance text-3xl font-black leading-tight tracking-tight sm:text-[42px]">
            {isDetail ? (
              product?.name
            ) : activeId ? (
              <span className="bg-linear-to-r from-primary to-primary/40 bg-clip-text text-transparent">
                {findThemedCategoryName(categories, activeId)}
              </span>
            ) : (
              <span className="bg-linear-to-r from-primary to-primary/40 bg-clip-text text-transparent">
                服务目录
              </span>
            )}
          </h1>
          {!isDetail ? (
            <p className="mt-5 max-w-xl text-[15px] leading-7 text-muted-foreground">
              挑选心仪的服务，加入购物车或直接结算。即开即用、按需升配、全程有人。
            </p>
          ) : null}
          {!isDetail ? (
            <a
              href="/shop/cart"
              className="mt-8 inline-flex h-[49px] items-center gap-2 rounded-lg bg-primary px-6 text-[15px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Icon name="cart" />
              查看购物车
            </a>
          ) : (
            <a
              href="/shop"
              className="mt-8 inline-flex h-11 items-center gap-2 rounded-xl bg-foreground px-6 text-sm font-semibold text-background shadow-md shadow-foreground/10 transition-transform hover:scale-[1.02] active:scale-[0.99]"
            >
              返回服务目录
              <Icon name="arrow" />
            </a>
          )}
        </div>
      </header>
      {!isDetail && hasCatalog ? (
        <div className="mt-12 grid gap-10 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="h-fit rounded-2xl border border-border/70 bg-card p-4 shadow-sm lg:sticky lg:top-20">
            <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              商品分类
            </p>
            <nav aria-label="商品分类">
              {showAll ? (
                <a
                  href="/shop?showAll=1"
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-muted ${
                    !activeId
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground'
                  }`}
                >
                  <span className="flex items-center text-primary">
                    <Icon name="box" />
                  </span>
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
            {activeId ? (
              <ThemedCategoryBreadcrumb categories={categories} activeId={activeId} />
            ) : null}
            {renderCatalogProducts(catalogResult)}
          </section>
        </div>
      ) : (
        <>
          {list.length > 0 ? (
            <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((item) => (
                <ThemedProductCard key={item.id} item={item} />
              ))}
            </div>
          ) : (
            <ThemedShopEmpty text="暂无在售服务" hint="新服务正在上架，稍后再来看看。" />
          )}
        </>
      )}
    </main>
  );
}

/** 商品卡：与首页能力卡 / 博客卡同一视觉语言（22px 圆角、悬停上浮、品牌蓝强调）。 */
function ThemedProductCard({ item }: { item: ThemedProduct }): ReactElement {
  const soldOut = item.stock <= 0;
  return (
    <a
      href={`/shop/${item.id}`}
      className="group relative flex h-full flex-col overflow-hidden rounded-[22px] border border-border/70 bg-card text-card-foreground shadow-sm transition-all hover:-translate-y-1 hover:border-primary/40 hover:shadow-md"
    >
      <div
        className="pointer-events-none absolute -right-20 -top-20 size-48 rounded-full bg-primary/10 opacity-0 blur-3xl transition-opacity group-hover:opacity-100"
        aria-hidden="true"
      />
      <div className="flex items-start justify-between gap-4 p-6 pb-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform group-hover:scale-110">
          <Icon name="box" />
        </span>
        <ThemedStockBadge stock={item.stock} />
      </div>
      <div className="flex flex-1 flex-col px-6">
        <h3 className="text-base font-semibold tracking-tight transition-colors group-hover:text-primary">
          {item.name}
        </h3>
        {item.description ? (
          <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
            {item.description}
          </p>
        ) : null}
      </div>
      <div className="relative mt-5 flex items-end justify-between gap-3 border-t border-border/60 px-6 py-4">
        <ThemedPrice item={item} />
        <span
          className={`inline-flex items-center gap-1.5 text-sm font-medium transition-colors ${
            soldOut ? 'text-muted-foreground/70' : 'text-muted-foreground group-hover:text-primary'
          }`}
        >
          {soldOut ? '暂时缺货' : '查看详情'}
          <span className="transition-transform group-hover:translate-x-0.5">
            <Icon name="arrow" />
          </span>
        </span>
      </div>
    </a>
  );
}

/** 库存徽标：有货绿点 / 缺货灰点（色值走 theme token）。 */
function ThemedStockBadge({ stock }: { stock: number }): ReactElement {
  return stock > 0 ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
      <span className="size-1.5 rounded-full bg-current" />
      有货
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      <span className="size-1.5 rounded-full bg-current" />
      暂时缺货
    </span>
  );
}

/** 空态：虚线卡 + 图标 + 主/副文案（与主题其余空态一致）。 */
function ThemedShopEmpty({
  text,
  hint,
  action,
}: {
  text: string;
  hint?: string;
  action?: { label: string; href: string };
}): ReactElement {
  return (
    <div className="mt-12 flex flex-col items-center rounded-[22px] border border-dashed border-border/70 bg-card/50 px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Icon name="box" />
      </span>
      <p className="mt-4 text-sm font-medium">{text}</p>
      {hint ? <p className="mt-1.5 text-sm text-muted-foreground">{hint}</p> : null}
      {action ? (
        <a
          href={action.href}
          className="mt-6 inline-flex h-10 items-center gap-2 rounded-lg border bg-background px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted/60"
        >
          {action.label}
          <Icon name="arrow" />
        </a>
      ) : null}
    </div>
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
        className={`flex items-center justify-between gap-2 rounded-lg py-2 pl-3 pr-2 text-sm transition-colors hover:bg-muted ${
          isActive ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground'
        }`}
      >
        <span className="truncate">
          {node.icon ? `${node.icon} ` : ''}
          {node.name}
        </span>
        {node.productCount > 0 ? (
          <span
            className={`shrink-0 rounded-full px-1.5 text-xs tabular-nums ${
              isActive ? 'bg-primary/15 text-primary' : 'bg-muted'
            }`}
          >
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
    | {
        products: ThemedCatalogProduct[];
        total: number;
        page: number;
        pageSize: number;
        categoryId: string | null;
      }
    | undefined,
): ReactElement {
  const entries = catalogResult?.products ?? [];
  if (!entries.length) {
    return (
      <div className="mt-4">
        <ThemedShopEmpty
          text={catalogResult ? '该分类下暂无在售服务' : '请选择一个分类查看服务'}
          hint={catalogResult ? '换个分类看看，或浏览全部分类。' : '从左侧分类中挑选你需要的服务。'}
          action={catalogResult ? { label: '浏览全部分类', href: '/shop?showAll=1' } : undefined}
        />
      </div>
    );
  }
  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">
        共 <span className="font-semibold tabular-nums text-foreground">{catalogResult.total}</span>{' '}
        件服务
      </p>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map(({ product: item }) => (
          <ThemedProductCard key={item.id} item={item} />
        ))}
      </div>
    </>
  );
}

/** 商品价格：等宽售价 + 划线原价 + 折扣徽标。 */
function ThemedPrice({ item }: { item: ThemedProduct }): ReactElement {
  const original =
    item.originalPrice != null && item.originalPrice > item.price ? item.originalPrice : null;
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-lg font-bold tracking-tight tabular-nums text-primary">
          <span className="align-super text-[0.6em] font-semibold opacity-80">
            {item.currency}{' '}
          </span>
          {(item.price / 100).toFixed(2)}
        </span>
        {original != null ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground/60 line-through">
            {item.currency} {(original / 100).toFixed(2)}
          </span>
        ) : null}
      </span>
      {item.discount != null && item.discount > 0 ? (
        <span className="w-fit rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
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
