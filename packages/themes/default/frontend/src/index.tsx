import { settingsSchema } from './settings.js';
import { ArticlePage } from './article.js';
import Link from 'next/link';
import { ProductListPage, ProductDetailPage, StoreCartPage } from './storefront.js';
import type { ReactElement, ReactNode } from 'react';
import {
  ArrowRight,
  Check,
  Layers3,
  Server,
  ShieldCheck,
  Database,
  Activity,
  Network,
  Headphones,
  type LucideIcon,
} from 'lucide-react';
import {
  defineFrontend,
  type FrontendLayoutProps,
  type FrontendPackage,
  type FrontendPageProps,
  type FrontendSettings,
} from '@stackpanel/sdk';
import {
  Reveal,
  RevealText,
  GlassNavigation,
  Spotlight,
  DocumentScrollbar,
  HeroRays,
  BorderBeam,
  SmoothDocument,
  PlatformStories,
  PricingInfo,
  AnimatedGridPattern,
  Marquee,
} from '@stackpanel/ui';
import { RouteProgress } from './route-progress.js';

const container = 'mx-auto w-full max-w-7xl px-4 md:px-12 xl:px-0';

function safeHref(value: string, fallback = '#'): string {
  const href = value.trim();
  if (/[\u0000-\u0020\\]/.test(href)) return fallback;
  return /^(\/(?!\/)|#|https?:\/\/|mailto:|tel:)/i.test(href) ? href : fallback;
}
function setting(
  settings: FrontendSettings | undefined,
  group: string,
  name: string,
  fallback: string,
): string {
  const value = settings?.[group]?.[name];
  if (name.toLowerCase().includes('href') || name.startsWith('link'))
    return safeHref(typeof value === 'string' ? value : fallback, fallback);
  return typeof value === 'string' ? value : fallback;
}
function settingLinks(
  settings: FrontendSettings | undefined,
  group: string,
  name: string,
  fallback: Array<[string, string]>,
): Array<[string, string]> {
  const value = settings?.[group]?.[name];
  if (!Array.isArray(value)) return fallback;
  return value.flatMap((item) =>
    typeof item === 'object' &&
    item &&
    typeof item.label === 'string' &&
    typeof item.href === 'string'
      ? [[item.label, safeHref(item.href)] as [string, string]]
      : [],
  );
}

function ActionLink({
  href,
  children,
  outline = false,
}: {
  href: string;
  children: ReactNode;
  outline?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-full px-4 text-sm transition duration-300 active:translate-y-px motion-reduce:transform-none focus-visible:outline-2 focus-visible:outline-ring ${outline ? 'border border-border bg-transparent text-foreground hover:bg-muted' : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}
    >
      {children}
    </Link>
  );
}

function Hero({ settings }: { settings?: FrontendSettings }) {
  const badge = setting(settings, 'hero', 'badge', '面向下一代业务的云平台');
  const titleLine1 = setting(settings, 'hero', 'titleLine1', '以 AI 驱动，');
  const titleLine2 = setting(settings, 'hero', 'titleLine2', '让业务更进一步。');
  const description = setting(
    settings,
    'hero',
    'description',
    'AI 驱动的云平台，汇聚云服务器、存储、数据库与模型服务。\n从创意起步到业务拓展，为你的每一步提供云端支撑。',
  );
  return (
    <section data-section="hero" className="relative overflow-hidden">
      <HeroRays />
      <div
        className={`${container} relative flex min-h-[680px] items-center pb-20 pt-40 lg:pb-24 lg:pt-44`}
      >
        <div className="mx-auto w-full max-w-2xl text-center">
          <Reveal>
            <Link
              href={setting(settings, 'hero', 'badgeHref', '#features')}
              className="relative inline-flex h-8 items-center gap-2 overflow-hidden rounded-full border border-primary/30 bg-gradient-to-r from-primary/0 via-primary/15 to-primary/30 py-1 pl-1 pr-3 text-sm text-foreground/80 transition-colors hover:text-foreground"
            >
              <span className="rounded-full bg-primary px-2 py-0.5 text-primary-foreground">
                {setting(settings, 'hero', 'badgeLabel', 'AI 驱动')}
              </span>
              <BorderBeam
                duration={6}
                size={50}
                colorFrom="var(--clarity-border-highlight)"
                colorTo="var(--clarity-primary)"
                className="motion-reduce:hidden"
              />
              {badge}
              <ArrowRight className="size-4" />
            </Link>
          </Reveal>
          <Reveal>
            <h1 className="mt-7 max-w-2xl text-center text-[42px] font-normal leading-[1.12] tracking-tighter sm:text-5xl md:text-6xl lg:text-[76px] lg:leading-[1.05]">
              <RevealText text={titleLine1} />
              <RevealText
                text={setting(settings, 'hero', 'highlight', '加速创新')}
                className="text-primary"
              />
              <br />
              <RevealText text={titleLine2} />
            </h1>
          </Reveal>
          <Reveal>
            <p className="mx-auto mt-6 max-w-xl text-balance text-center text-sm leading-6 tracking-tight text-muted-foreground lg:text-base">
              {description.split('\n').map((line, index) => (
                <span key={line}>
                  {index > 0 && <br className="hidden md:block" />}
                  {line}
                </span>
              ))}
            </p>
          </Reveal>
          <Reveal>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <ActionLink href={setting(settings, 'hero', 'primaryHref', '/shop')}>
                {setting(settings, 'hero', 'primaryLabel', '选购云产品')}
              </ActionLink>
              <ActionLink href={setting(settings, 'hero', 'secondaryHref', '#features')} outline>
                {setting(settings, 'hero', 'secondaryLabel', '了解云产品')}
              </ActionLink>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Ecosystem({ settings }: { settings?: FrontendSettings }) {
  return (
    <section data-section="ecosystem" className="relative py-12 md:py-16 lg:min-h-[220px]">
      <div className={`${container} group/ecosystem relative`}>
        <Reveal>
          <p className="text-center text-sm text-muted-foreground">
            {setting(settings, 'ecosystem', 'text1', '连接熟悉的技术栈，构建下一代应用')}
          </p>
        </Reveal>
        <Reveal>
          <div className="mx-auto mt-8 overflow-hidden text-xl font-medium tracking-tight text-muted-foreground transition-[filter,opacity] duration-300 group-hover/ecosystem:opacity-50 group-hover/ecosystem:blur-[4px] group-focus-within/ecosystem:blur-[4px] [mask-image:linear-gradient(to_right,transparent,black_10%,black_90%,transparent)]">
            <Marquee
              pauseOnHover
              repeat={2}
              className="[--duration:35s] [--gap:3rem] md:[--gap:5rem] **:motion-reduce:animate-none"
            >
              {(Array.isArray(settings?.ecosystem?.technologies)
                ? settings.ecosystem.technologies.map((item) => String(item.label ?? ''))
                : [
                    'Linux',
                    'Docker',
                    'Kubernetes',
                    'PostgreSQL',
                    'Node.js',
                    'Redis',
                    'OpenAPI',
                    'Terraform',
                  ]
              ).map((name) => (
                <span key={name} className="shrink-0 py-3">
                  {name}
                </span>
              ))}
            </Marquee>
          </div>
        </Reveal>
        <Link
          href={setting(settings, 'ecosystem', 'link2', '#capabilities')}
          className="absolute inset-0 flex items-center justify-center gap-2 bg-background/60 text-sm opacity-0 backdrop-blur-[2px] transition-opacity duration-300 hover:opacity-100 focus:opacity-100 group-hover/ecosystem:opacity-100"
        >
          {setting(settings, 'ecosystem', 'copy1', '探索云服务')}
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </section>
  );
}

function Features({
  assetsBaseUrl,
  settings,
}: {
  assetsBaseUrl: string;
  settings?: FrontendSettings;
}) {
  const features = [
    {
      title: setting(settings, 'features', 'text1', '云服务器，承载业务核心'),
      body: setting(
        settings,
        'features',
        'text2',
        '从网站部署到业务系统，选择匹配负载的计算资源，为应用构建独立的运行环境。',
      ),
      points: [
        setting(settings, 'features', 'text3', '多种规格可选'),
        setting(settings, 'features', 'text4', '独立运行环境'),
        setting(settings, 'features', 'text5', '在线选购与管理'),
      ],
      image: 'feature/feature-elastic-compute.png',
    },
    {
      title: setting(settings, 'features', 'text6', '云存储，连接数据价值'),
      body: setting(
        settings,
        'features',
        'text7',
        '为应用文件、内容分发与业务数据选择存储资源，让数据成为业务发展的基础。',
      ),
      points: [],
      image: 'feature/feature-simple-management.png',
    },
    {
      title: setting(settings, 'features', 'text8', '云数据库，支撑关键应用'),
      body: setting(
        settings,
        'features',
        'text9',
        '为业务应用配置数据库资源，从开发验证到生产运行，构建清晰的数据服务体系。',
      ),
      points: [
        setting(settings, 'features', 'text10', '按应用需求选型'),
        setting(settings, 'features', 'text11', '清晰的资源规格'),
        setting(settings, 'features', 'text12', '集中查看与管理'),
      ],
      image: 'feature/feature-secure-network.png',
    },
    {
      title: setting(settings, 'features', 'text13', '模型服务，拓展应用可能'),
      body: setting(
        settings,
        'features',
        'text14',
        '将模型能力融入产品与工作流程，为智能应用与 AI 业务探索更多可能。',
      ),
      points: [],
      image: 'feature/feature-flexible-config.png',
    },
  ];

  return (
    <section
      id="features"
      data-section="features"
      className="scroll-mt-24 relative overflow-hidden py-24 lg:min-h-[1120px]"
    >
      <div className={container}>
        <div className="mb-16 flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <div className="max-w-2xl">
            <Reveal>
              <h2 className="text-4xl font-normal leading-none md:text-5xl">
                {setting(settings, 'features', 'copy1', '从云端算力，')}
                <br />
                <span className="text-primary">
                  {setting(settings, 'features', 'text15', '到智能应用')}
                </span>
              </h2>

              <p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">
                {setting(
                  settings,
                  'features',
                  'copy2',
                  '计算、存储、数据库与模型服务，在一个平台发现、选购与管理。',
                )}
              </p>
            </Reveal>
          </div>
          <Reveal>
            <ActionLink href={setting(settings, 'features', 'link16', '/shop')} outline>
              {setting(settings, 'features', 'copy3', '浏览产品')}
              <ArrowRight className="size-4" />
            </ActionLink>
          </Reveal>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {features.map((f) => (
            <Reveal key={f.title} className="h-full">
              <Spotlight>
                <article className="group relative min-h-[350px] overflow-hidden md:min-h-80 rounded-xl bg-transparent p-6 shadow-xl shadow-primary/5 backdrop-blur-xl transition duration-500 md:p-8">
                  <div className="relative z-10 max-w-full md:max-w-[75%]">
                    <h3 className="max-w-sm text-2xl font-normal leading-7">{f.title}</h3>
                    <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                      {f.body}
                    </p>
                    <ul className="mt-6 flex flex-col gap-3">
                      {f.points.map((point) => (
                        <li key={point} className="flex items-center gap-2 text-sm">
                          <Check className="size-4 text-primary" />
                          {point}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <img
                    src={`${assetsBaseUrl}/glass-theme/${f.image}`}
                    width={200}
                    height={200}
                    alt={f.title}
                    loading="lazy"
                    className="pointer-events-none absolute bottom-3 right-2 h-28 w-44 object-contain transition-transform duration-700 motion-safe:group-hover:-translate-y-2 sm:bottom-4 sm:right-4 sm:h-36 sm:w-56"
                  />
                </article>
              </Spotlight>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Capabilities({ settings }: { settings?: FrontendSettings }) {
  const capabilities: Array<{ icon: LucideIcon; title: string; body: string }> = [
    {
      icon: Server,
      title: setting(settings, 'capabilities', 'text1', '弹性计算'),
      body: setting(
        settings,
        'capabilities',
        'text2',
        '按应用负载挑选计算规格，让预算花在需要的算力上。',
      ),
    },
    {
      icon: Network,
      title: setting(settings, 'capabilities', 'text3', '网络连接'),
      body: setting(
        settings,
        'capabilities',
        'text4',
        '按服务访问需求选择网络配置，连接你的用户与应用。',
      ),
    },
    {
      icon: Database,
      title: setting(settings, 'capabilities', 'text5', '数据存储'),
      body: setting(
        settings,
        'capabilities',
        'text6',
        '为文件与业务数据选择存储容量，满足应用的日常使用。',
      ),
    },
    {
      icon: Activity,
      title: setting(settings, 'capabilities', 'text7', 'AI 辅助'),
      body: setting(
        settings,
        'capabilities',
        'text8',
        '通过 AI 助手理解需求、获取操作建议，让云服务的使用更直观。',
      ),
    },
    {
      icon: ShieldCheck,
      title: setting(settings, 'capabilities', 'text9', '账户安全'),
      body: setting(
        settings,
        'capabilities',
        'text10',
        '管理账户与访问权限，让云资源的使用保持清晰可控。',
      ),
    },
    {
      icon: Headphones,
      title: setting(settings, 'capabilities', 'text11', '技术支持'),
      body: setting(
        settings,
        'capabilities',
        'text12',
        '从资源选型到使用问题，获得清晰的技术协助。',
      ),
    },
  ];

  return (
    <section
      id="capabilities"
      data-section="capabilities"
      className="scroll-mt-24 px-4 py-8 md:px-12 lg:min-h-[788px] xl:px-0"
    >
      <div className="mx-auto max-w-7xl">
        <div className="max-w-2xl text-left">
          <Reveal>
            <h2 className="text-4xl font-normal tracking-tight md:text-5xl">
              {setting(settings, 'capabilities', 'copy1', '让云更易用，')}
              <span className="block text-primary">
                {setting(settings, 'capabilities', 'text13', '让创新更专注')}
              </span>
            </h2>

            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              {setting(
                settings,
                'capabilities',
                'copy2',
                '以 AI 交互连接云服务，从资源选型到日常管理，让你更专注于产品与客户。',
              )}
            </p>
          </Reveal>
        </div>
        <div className="mt-20 grid gap-4 md:grid-cols-3">
          {capabilities.map((c) => (
            <Reveal key={c.title} className="h-full">
              <Spotlight>
                <article className="min-h-[260px] rounded-xl bg-transparent p-8 shadow-xl shadow-primary/5 backdrop-blur-xl transition duration-500 ">
                  <div className="mb-8 flex size-12 items-center justify-center rounded-lg bg-muted">
                    <c.icon className="size-6" />
                  </div>
                  <h3 className="text-base font-normal">{c.title}</h3>
                  <p className="mt-2 max-w-xs text-sm leading-6 text-muted-foreground">{c.body}</p>
                </article>
              </Spotlight>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function UseCases({
  assetsBaseUrl,
  settings,
}: {
  assetsBaseUrl: string;
  settings?: FrontendSettings;
}) {
  return (
    <section
      id="use-cases"
      data-section="use-cases"
      className="scroll-mt-24 pt-20 lg:min-h-[804px]"
    >
      <div className={container}>
        <div className="max-w-2xl text-left">
          <Reveal>
            <h2 className="text-4xl font-normal tracking-tight md:text-5xl">
              {setting(settings, 'useCases', 'copy1', '从一个想法，')}
              <span className="block text-primary">
                {setting(settings, 'useCases', 'text1', '到下一次突破')}
              </span>
            </h2>

            <p className="mt-4 max-w-prose text-balance text-sm leading-6 tracking-tight text-muted-foreground lg:text-base">
              {setting(
                settings,
                'useCases',
                'copy2',
                '无论构建网站、企业系统还是智能应用，都有适合的云产品作为起点。',
              )}
            </p>
          </Reveal>
        </div>
        <div className="my-12 grid gap-4 md:grid-cols-2">
          {[
            {
              tag: setting(settings, 'useCases', 'text2', '网站与应用'),
              image: 'product/product-browser-card.png',
              title: setting(settings, 'useCases', 'text3', '让产品稳定在线'),
              body: setting(
                settings,
                'useCases',
                'text4',
                '为网站、API 与业务应用提供可靠的运行环境。',
              ),
            },
            {
              tag: setting(settings, 'useCases', 'text5', '开发与测试'),
              image: 'product/product-revenue-growth.png',
              title: setting(settings, 'useCases', 'text6', '快速搭建独立环境'),
              body: setting(
                settings,
                'useCases',
                'text7',
                '为团队准备一致的开发测试资源，缩短环境交付时间。',
              ),
            },
            {
              tag: setting(settings, 'useCases', 'text8', '数据与存储'),
              image: 'product/product-vip-star.png',
              title: setting(settings, 'useCases', 'text9', '管理业务中的关键数据'),
              body: setting(
                settings,
                'useCases',
                'text10',
                '为数据服务与持久化存储安排适合的资源配置。',
              ),
            },
            {
              tag: setting(settings, 'useCases', 'text11', 'AI 与企业应用'),
              image: 'product/product-user-payment.png',
              title: setting(settings, 'useCases', 'text12', '让智能融入业务'),
              body: setting(
                settings,
                'useCases',
                'text13',
                '连接模型服务与云端资源，探索智能助手、业务自动化与企业应用。',
              ),
            },
          ].map((c) => (
            <Reveal key={c.tag} className="h-full">
              <Spotlight>
                <article className="group relative flex h-full flex-col items-start overflow-hidden rounded-xl bg-gradient-to-br from-muted/20 to-background/0 p-6 shadow-2xl shadow-primary/5 transition-shadow duration-500 hover:shadow-primary/10 lg:p-8">
                  <img
                    src={`${assetsBaseUrl}/glass-theme/${c.image}`}
                    width={c.image.endsWith('product-browser-card.png') ? 128 : 180}
                    height={c.image.endsWith('product-browser-card.png') ? 128 : 180}
                    alt=""
                    loading="lazy"
                    className="pointer-events-none absolute right-4 top-4 h-16 w-20 object-contain transition-transform duration-700 motion-safe:group-hover:-translate-y-1 sm:h-20 sm:w-28"
                  />
                  <span className="mb-4 inline-flex rounded-full bg-primary/20 px-3 py-1 text-sm text-foreground md:py-1.5">
                    {c.tag}
                  </span>
                  <h3 className="max-w-[calc(100%-5rem)] text-xl font-normal leading-7 tracking-tight md:text-2xl">
                    {c.title}
                  </h3>
                  <p className="mt-4 max-w-md flex-1 text-sm leading-6 text-muted-foreground lg:text-base">
                    {c.body}
                  </p>
                  <Link
                    href={setting(settings, 'useCases', 'link14', '/shop')}
                    className="group/link mt-8 inline-flex items-center gap-2 text-sm text-primary transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring lg:text-base"
                  >
                    {setting(settings, 'useCases', 'copy3', '查看相关服务')}
                    <ArrowRight className="size-4 transition-transform duration-300 group-hover/link:translate-x-1 motion-reduce:transform-none" />
                  </Link>
                </article>
              </Spotlight>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Statement({ settings }: { settings?: FrontendSettings }) {
  return (
    <section
      data-section="statement"
      className="relative flex min-h-[60vh] items-center justify-center overflow-hidden px-6 py-24 md:min-h-[76vh] lg:min-h-[856px]"
    >
      <AnimatedGridPattern
        width={64}
        height={64}
        numSquares={24}
        maxOpacity={0.08}
        className="opacity-30 stroke-border fill-primary [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)] motion-reduce:hidden"
      />
      <Reveal className="w-full">
        <PlatformStories
          {...(Array.isArray(settings?.stories?.items)
            ? {
                items: settings.stories.items.map((item) => ({
                  text: String(item.text ?? ''),
                  label: String(item.label ?? ''),
                  detail: String(item.detail ?? ''),
                })),
              }
            : {})}
          actionLabel={setting(settings, 'stories', 'actionLabel', '了解云产品')}
          actionHref={setting(settings, 'stories', 'actionHref', '#features')}
        />
      </Reveal>
    </section>
  );
}

function Pricing({ settings }: { settings?: FrontendSettings }) {
  return (
    <section
      id="pricing"
      data-section="pricing"
      className="scroll-mt-24 relative overflow-hidden px-4 pb-20 pt-12 md:px-12 lg:min-h-[1042px] lg:pb-40"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_bottom,transparent,black_8%,black_75%,transparent)]"
      >
        <div className="absolute -top-[10%] left-1/2 h-[40%] w-[60%] -translate-x-1/2 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -right-[10%] -bottom-[10%] h-[40%] w-[40%] rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-[10%] -left-[10%] h-[40%] w-[40%] rounded-full bg-primary/5 blur-3xl" />
      </div>
      <div className="relative">
        <Reveal className="mx-auto max-w-5xl text-left">
          <h2 className="text-4xl font-normal tracking-tight md:text-5xl">
            {setting(settings, 'pricing', 'copy1', '匹配业务阶段，')}
            <span className="block text-primary">
              {setting(settings, 'pricing', 'text1', '开启云端新篇章')}
            </span>
          </h2>

          <p className="mt-4 max-w-prose text-sm leading-6 text-muted-foreground">
            {setting(
              settings,
              'pricing',
              'copy2',
              '按配置、价格与计费周期比较云产品，为当前需求与下一步发展做出选择。',
            )}
          </p>
        </Reveal>
        <div className="mx-auto mt-12 grid max-w-5xl gap-4 md:grid-cols-3">
          {[
            {
              title: setting(settings, 'pricing', 'text2', '轻量起步'),
              intro: setting(settings, 'pricing', 'text3', '开发与测试'),
              list: [
                setting(settings, 'pricing', 'text4', '个人网站与小型应用'),
                setting(settings, 'pricing', 'text5', '开发测试环境'),
                setting(settings, 'pricing', 'text6', '按预算选择配置'),
                setting(settings, 'pricing', 'text7', '在线查看规格与价格'),
              ],
            },
            {
              title: setting(settings, 'pricing', 'text8', '生产业务'),
              intro: setting(settings, 'pricing', 'text9', '稳定与扩展'),
              list: [
                setting(settings, 'pricing', 'text10', '网站与业务应用'),
                setting(settings, 'pricing', 'text11', '按负载选择算力'),
                setting(settings, 'pricing', 'text12', '搭配存储与数据库'),
                setting(settings, 'pricing', 'text13', '控制台管理已购服务'),
              ],
            },
            {
              title: setting(settings, 'pricing', 'text14', '企业需求'),
              intro: setting(settings, 'pricing', 'text15', '按业务选型'),
              list: [
                setting(settings, 'pricing', 'text16', '企业业务系统'),
                setting(settings, 'pricing', 'text17', '多环境部署需求'),
                setting(settings, 'pricing', 'text18', '按业务规模选型'),
                setting(settings, 'pricing', 'text19', '产品选型与技术协助'),
              ],
            },
          ].map((plan, i) => (
            <Reveal key={plan.title} className="h-full">
              <Spotlight>
                <article
                  className={`flex min-h-[620px] flex-col rounded-xl bg-background/40 p-6 shadow-xl shadow-primary/5 backdrop-blur-xl transition duration-500 ${i === 1 ? 'bg-primary text-primary-foreground' : 'bg-muted/50'}`}
                >
                  <Layers3 className="mb-5 size-8" aria-hidden="true" />
                  <h3 className="text-base font-normal">{plan.title}</h3>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <p className="text-3xl tracking-tight">{plan.intro}</p>
                    <PricingInfo
                      text={setting(
                        settings,
                        'pricing',
                        'text20',
                        '资源规格、计费周期与服务范围以商城商品详情为准。',
                      )}
                    />
                  </div>
                  <p
                    className={`mt-10 text-xs ${i === 1 ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}
                  >
                    {setting(settings, 'pricing', 'copy3', '适用需求')}
                  </p>
                  <ul className="mt-5 flex flex-col gap-4 border-t border-dashed border-current/20 pt-5 text-sm">
                    {plan.list.map((item) => (
                      <li key={item} className="flex items-center gap-2">
                        <Check className="size-4" />
                        {item}
                      </li>
                    ))}
                  </ul>
                  <Link
                    href={setting(settings, 'pricing', 'link21', '/shop')}
                    className={`mt-auto inline-flex h-9 items-center justify-center rounded-full text-sm ${i === 1 ? 'bg-primary-foreground text-primary' : 'bg-primary text-primary-foreground'}`}
                  >
                    {setting(settings, 'pricing', 'copy4', '查看产品与价格')}
                  </Link>
                </article>
              </Spotlight>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer({ settings, brandName }: { settings?: FrontendSettings; brandName: string }) {
  const groups = [
    {
      title: setting(settings, 'footer', 'column1Title', '应用场景'),
      links: settingLinks(settings, 'footer', 'column1Links', [
        ['网站与应用', '/#use-cases'],
        ['开发与测试', '/#use-cases'],
        ['数据与存储', '/#use-cases'],
        ['企业应用', '/#use-cases'],
      ]),
    },
    {
      title: setting(settings, 'footer', 'column2Title', '产品'),
      links: settingLinks(settings, 'footer', 'column2Links', [
        ['云服务器', '/shop'],
        ['云存储', '/shop'],
        ['云数据库', '/shop'],
      ]),
    },
    {
      title: setting(settings, 'footer', 'column3Title', '资源'),
      links: settingLinks(settings, 'footer', 'column3Links', [
        ['服务优势', '/#capabilities'],
        ['应用场景', '/#use-cases'],
        ['服务选型', '/#pricing'],
      ]),
    },
    {
      title: setting(settings, 'footer', 'column4Title', '开始使用'),
      links: settingLinks(settings, 'footer', 'column4Links', [
        ['选购云产品', '/shop'],
        ['登录账户', '/login'],
        ['注册账户', '/register'],
      ]),
    },
  ];
  return (
    <footer
      data-section="footer"
      className="relative isolate w-full overflow-hidden border-t border-border"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 -left-2 -z-10 w-full opacity-50 [background-image:linear-gradient(to_right,var(--clarity-grid)_1px,transparent_1px),linear-gradient(to_bottom,var(--clarity-grid)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:linear-gradient(to_bottom,transparent,black)]"
      />
      <div className="relative mx-auto max-w-7xl px-6 pb-12 pt-12 md:px-12 lg:pt-16 2xl:px-8">
        <div className="flex flex-col gap-12 lg:flex-row lg:gap-16">
          <Reveal className="flex flex-col items-center gap-4 lg:items-start xl:min-w-80">
            <Link href="/" className="flex h-10 items-center gap-2 text-2xl font-semibold">
              <Layers3 className="size-10 text-primary" />
              {brandName}
            </Link>
            <p className="max-w-xs text-center text-sm leading-relaxed text-muted-foreground md:text-base lg:text-left">
              {setting(
                settings,
                'footer',
                'description',
                'AI 驱动的云平台，提供云服务器、存储、数据库与模型服务，助力业务创新。',
              )}
            </p>
            <nav aria-label="云服务快捷入口" className="flex items-center gap-4">
              {settingLinks(settings, 'footer', 'links', [
                ['选购云产品', '/shop'],
                ['账户控制台', '/account'],
                ['服务优势', '/#capabilities'],
                ['产品与价格', '/#pricing'],
              ]).map(([label, href], index) => {
                const Icon = [Server, Layers3, ShieldCheck, Database][index % 4]!;
                return (
                  <Link
                    key={`${label}-${index}`}
                    href={href}
                    aria-label={label}
                    className="text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <Icon aria-hidden="true" className="size-6" />
                  </Link>
                );
              })}
            </nav>
          </Reveal>
          <nav
            aria-label="页脚导航"
            className="grid flex-1 grid-cols-2 gap-10 sm:grid-cols-4 sm:gap-8 lg:pt-2.5"
          >
            {groups.map((g) => (
              <Reveal key={g.title} className="flex flex-col gap-4">
                <h3 className="text-sm font-medium tracking-tight text-muted-foreground md:text-base">
                  {g.title}
                </h3>
                <ul className="flex flex-col gap-2.5">
                  {g.links.map(([label, href]) => (
                    <li key={label}>
                      <Link
                        href={href}
                        className="text-sm tracking-tight text-foreground transition-opacity duration-200 hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring md:text-base"
                      >
                        {label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Reveal>
            ))}
          </nav>
        </div>
        <Reveal className="mt-16 text-center text-sm text-muted-foreground">
          {setting(settings, 'footer', 'copyright', `© ${new Date().getFullYear()} ${brandName}`)}
        </Reveal>
      </div>
    </footer>
  );
}

function HomePage(props: FrontendPageProps): ReactElement {
  const settings = props.settings;
  const assetsBaseUrl = props.assetsBaseUrl ?? '/api/plugins/themes/default/assets';
  return (
    <main className="flex-1">
      <Hero settings={settings} />
      <Ecosystem settings={settings} />
      <Features assetsBaseUrl={assetsBaseUrl} settings={settings} />
      <Capabilities settings={settings} />
      <UseCases assetsBaseUrl={assetsBaseUrl} settings={settings} />
      <Statement settings={settings} />
      <Pricing settings={settings} />
      <section
        data-section="cta"
        className={`${container} pb-20 pt-12 text-left lg:min-h-[316px] lg:pb-32`}
      >
        <Reveal>
          <h2 className="text-4xl font-normal tracking-tight md:text-5xl">
            {setting(settings, 'cta', 'copy1', '为你的下一次上线，')}
            <span className="block text-primary">
              {setting(settings, 'cta', 'text1', '选好云资源')}
            </span>
          </h2>

          <p className="mt-4 max-w-prose text-sm leading-6 text-muted-foreground">
            {setting(settings, 'cta', 'copy2', '挑选适合的云产品，从今天开始部署你的网站与应用。')}
          </p>
        </Reveal>
        <Reveal className="mt-4 flex flex-wrap gap-4">
          <ActionLink href={setting(settings, 'cta', 'link2', '/shop')}>
            {setting(settings, 'cta', 'text3', '选购云产品')}
          </ActionLink>
          <ActionLink href={setting(settings, 'cta', 'link4', '#features')} outline>
            {setting(settings, 'cta', 'copy3', '了解云产品')}
          </ActionLink>
        </Reveal>
      </section>
    </main>
  );
}

function DefaultLayout({
  children,
  navigation,
  isAuthenticated,
  platform,
  settings = {},
}: FrontendLayoutProps): ReactElement {
  const links = settingLinks(settings, 'navigation', 'links', [
    ['云产品', '/#features'],
    ['服务优势', '/#capabilities'],
    ['应用场景', '/#use-cases'],
    ['价格', '/#pricing'],
  ]).map(([label, href]) => ({ label, href }));
  if (settings?.navigation?.includePluginLinks !== false) links.push(...navigation);

  return (
    <div className="clarity-surface relative isolate flex min-h-screen flex-col bg-background text-foreground [--background:var(--clarity-background)] [--foreground:var(--clarity-foreground)] [--muted:var(--clarity-muted)] [--muted-foreground:var(--clarity-muted-foreground)] [--border:var(--clarity-border)] [--primary:var(--clarity-primary)] [--primary-foreground:var(--clarity-primary-foreground)] [--input:var(--clarity-border)] [--card:var(--clarity-background)] [--card-foreground:var(--clarity-foreground)] [--accent:var(--clarity-muted)] [--accent-foreground:var(--clarity-foreground)] [--ring:var(--clarity-primary)]">
      <RouteProgress />
      <GlassNavigation
        links={links.map((link) => ({
          ...link,
          content: (
            <Link
              href={link.href}
              className="flex size-full items-center rounded-[inherit] px-4 py-2 focus-visible:outline-2 focus-visible:outline-ring"
            >
              {link.label}
            </Link>
          ),
        }))}
        brand={
          <Link href="/" className="flex items-center gap-2 text-base font-semibold sm:text-xl">
            <Layers3 className="size-7 text-primary" />
            {platform.name || 'StackPanel'}
          </Link>
        }
        actions={
          <>
            <Link
              href={
                isAuthenticated
                  ? setting(settings, 'navigation', 'consoleHref', '/account')
                  : setting(settings, 'navigation', 'loginHref', '/login')
              }
              className="hidden h-9 items-center rounded-full px-4 text-sm transition-colors hover:bg-muted lg:inline-flex"
            >
              {isAuthenticated
                ? setting(settings, 'navigation', 'consoleLabel', '控制台')
                : setting(settings, 'navigation', 'loginLabel', '登录')}
            </Link>
            <ActionLink
              href={
                isAuthenticated
                  ? setting(settings, 'navigation', 'consoleHref', '/account')
                  : setting(settings, 'navigation', 'registerHref', '/register')
              }
            >
              {isAuthenticated
                ? setting(settings, 'navigation', 'consoleActionLabel', '进入控制台')
                : setting(settings, 'navigation', 'registerLabel', '开始使用')}
            </ActionLink>
          </>
        }
      />
      <div id="clarity-page-content" className="flex-1">
        {children}
      </div>
      <Footer settings={settings} brandName={platform.name || 'StackPanel'} />
      <DocumentScrollbar />
      <SmoothDocument />
    </div>
  );
}
const frontend: FrontendPackage = defineFrontend({
  settingsSchema,
  layouts: { default: DefaultLayout, theme: DefaultLayout },
  overrides: {
    '/blog/:slug': 'article',
    '/shop': 'shop',
    '/shop/:id': 'product',
    '/shop/cart': 'cart',
  },
  pages: [{ path: '/', component: 'home', layout: 'default' }],
  pageComponents: {
    home: HomePage,
    article: ArticlePage,
    shop: ProductListPage,
    product: ProductDetailPage,
    cart: StoreCartPage,
  },
});
export default frontend;
