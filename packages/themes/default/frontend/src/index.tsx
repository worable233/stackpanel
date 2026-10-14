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

function Hero({ assetsBaseUrl }: { assetsBaseUrl: string }) {
  return (
    <section data-section="hero" className="relative overflow-hidden">
      <HeroRays />
      <div className={`${container} relative flex flex-col items-center pt-48`}>
        <Reveal>
        <Link
          href="#features"
          className="relative inline-flex h-8 items-center gap-2 overflow-hidden rounded-full border border-primary/30 bg-gradient-to-r from-primary/0 via-primary/15 to-primary/30 py-1 pl-1 pr-3 text-sm text-foreground/80 transition-colors hover:text-foreground"
        >
          <span className="rounded-full bg-primary px-2 py-0.5 text-primary-foreground">
            云服务
          </span>
          <BorderBeam
            duration={6}
            size={50}
            colorFrom="var(--clarity-border-highlight)"
            colorTo="var(--clarity-primary)"
            className="motion-reduce:hidden"
          />
          为你的业务，选一朵好云
          <ArrowRight className="size-4" />
        </Link>
        </Reveal>
        <Reveal>
          <h1 className="mt-6 max-w-2xl text-center text-[36px] font-normal leading-[1.15] sm:text-[40px] tracking-tighter md:text-5xl lg:text-6xl lg:leading-[56px]">
            <RevealText text="你的业务，" />
            <RevealText text="即刻上云" className="text-primary" />
            <br />
            <RevealText text="从这里开始。" />
          </h1>
        </Reveal>
        <Reveal>
          <p className="mt-4 min-h-[71px] max-w-prose text-balance text-center text-sm leading-6 tracking-tight text-muted-foreground lg:text-base">
            选购云服务器、存储与数据库，为网站和应用找到合适的云资源。
            <br className="hidden md:block" />
            从个人项目到企业业务，让每一次上线都有可靠的支撑。
          </p>
        </Reveal>
        <Reveal>
          <div className="mt-4 flex flex-wrap justify-center gap-4">
            <ActionLink href="/shop">选购云产品</ActionLink>
            <ActionLink href="#features" outline>
              了解云产品
            </ActionLink>
          </div>
        </Reveal>
        <Reveal className="w-full">
          <div className="clarity-cloud-scene relative mx-auto mt-12 h-[280px] w-full max-w-5xl overflow-hidden rounded-2xl border border-primary/15 sm:h-[400px] lg:mt-16" role="img" aria-label="云产品玻璃插画">
            <img src={`${assetsBaseUrl}/glass-theme/background/bg-glass-panel-wide.png`} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover opacity-30" />
            <div aria-hidden="true" className="absolute inset-x-[10%] inset-y-[12%] rounded-full bg-primary/15 blur-3xl" />
            <div aria-hidden="true" className="absolute left-1/2 top-1/2 h-[190px] w-[280px] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-primary/20 sm:h-[280px] sm:w-[580px]" />
            <div aria-hidden="true" className="absolute left-1/2 top-1/2 h-[250px] w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-primary/10 sm:h-[370px] sm:w-[800px]" />
            {[
              { image: 'product/product-browser-card.png', position: 'left-1/2 top-1/2 z-10 w-[150px] -translate-x-1/2 -translate-y-1/2 sm:w-[230px]', delay: '0s' },
              { image: 'feature/feature-elastic-compute.png', position: 'left-[4%] top-[8%] w-[110px] sm:left-[12%] sm:w-[170px]', delay: '-2s' },
              { image: 'feature/feature-secure-network.png', position: 'right-[4%] top-[8%] w-[110px] sm:right-[12%] sm:w-[170px]', delay: '-4s' },
              { image: 'product/product-revenue-growth.png', position: 'bottom-[2%] left-[6%] w-[105px] sm:bottom-[5%] sm:left-[18%] sm:w-[160px]', delay: '-1s' },
              { image: 'product/product-user-payment.png', position: 'bottom-[2%] right-[6%] w-[105px] sm:bottom-[5%] sm:right-[18%] sm:w-[160px]', delay: '-3s' },
            ].map((item) => (
              <div key={item.image} className={`absolute ${item.position}`} aria-hidden="true">
                <img src={`${assetsBaseUrl}/glass-theme/${item.image}`} width={item.image.startsWith('feature/') ? 200 : item.image.endsWith('product-browser-card.png') ? 128 : 180} height={item.image.startsWith('feature/') ? 200 : item.image.endsWith('product-browser-card.png') ? 128 : 180} alt="" fetchPriority={item.delay === '0s' ? 'high' : 'auto'} className="clarity-glass-float h-auto w-full object-contain drop-shadow-2xl" style={{ animationDelay: item.delay }} />
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Ecosystem() {
  return (
    <section data-section="ecosystem" className="relative py-12 md:py-16 lg:min-h-[220px]">
      <div className={`${container} group/ecosystem relative`}>
        <Reveal>
          <p className="text-center text-sm text-muted-foreground">熟悉的技术栈，轻松部署到云端</p>
        </Reveal>
        <Reveal>
        <div className="mx-auto mt-8 overflow-hidden text-xl font-medium tracking-tight text-muted-foreground transition-[filter,opacity] duration-300 group-hover/ecosystem:opacity-50 group-hover/ecosystem:blur-[4px] group-focus-within/ecosystem:blur-[4px] [mask-image:linear-gradient(to_right,transparent,black_10%,black_90%,transparent)]">
          <Marquee
            pauseOnHover
            repeat={2}
            className="[--duration:35s] [--gap:3rem] md:[--gap:5rem] **:motion-reduce:animate-none"
          >
            {[
              'Linux',
              'Docker',
              'Kubernetes',
              'PostgreSQL',
              'Node.js',
              'Redis',
              'OpenAPI',
              'Terraform',
            ].map((name) => (
              <span key={name} className="shrink-0 py-3">
                {name}
              </span>
            ))}
          </Marquee>
        </div>
        </Reveal>
        <Link
          href="#capabilities"
          className="absolute inset-0 flex items-center justify-center gap-2 bg-background/60 text-sm opacity-0 backdrop-blur-[2px] transition-opacity duration-300 hover:opacity-100 focus:opacity-100 group-hover/ecosystem:opacity-100"
        >
          探索云服务
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </section>
  );
}

const features = [
  {
    title: '云服务器，为应用提供算力',
    body: '为网站、应用和后端服务选择合适的云服务器，把想法变成在线业务。',
    points: ['多种规格可选', '独立运行环境', '在线选购与管理'],
    image: 'feature/feature-elastic-compute.png',
  },
  {
    title: '云存储，安放业务数据',
    body: '为应用文件与业务数据选择存储空间，让容量适应当前需求。',
    points: [],
    image: 'feature/feature-simple-management.png',
  },
  {
    title: '云数据库，支撑业务应用',
    body: '为网站与应用的数据读写选择数据库资源，搭建业务所需的数据环境。',
    points: ['按应用需求选型', '清晰的资源规格', '集中查看与管理'],
    image: 'feature/feature-secure-network.png',
  },
  {
    title: '灵活选型，满足不同阶段',
    body: '从小型项目到生产应用，按预算、配置和使用周期选择云产品。',
    points: [],
    image: 'feature/feature-flexible-config.png',
  },
];
function Features({ assetsBaseUrl }: { assetsBaseUrl: string }) {
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
                从算力到数据，
                <br />
                <span className="text-primary">找到适合你的云产品</span>
              </h2>

              <p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">
                云服务器、存储与数据库，按业务需要选购，按你的节奏部署。
              </p>
            </Reveal>
          </div>
          <Reveal>
            <ActionLink href="/shop" outline>
              浏览产品
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

const capabilities: Array<{ icon: LucideIcon; title: string; body: string }> = [
  { icon: Server, title: '弹性计算', body: '按应用负载挑选计算规格，让预算花在需要的算力上。' },
  { icon: Network, title: '网络连接', body: '按服务访问需求选择网络配置，连接你的用户与应用。' },
  { icon: Database, title: '数据存储', body: '为文件与业务数据选择存储容量，满足应用的日常使用。' },
  { icon: Activity, title: '便捷管理', body: '在控制台查看已购服务，处理资源管理与日常操作。' },
  {
    icon: ShieldCheck,
    title: '账户安全',
    body: '管理账户与访问权限，让云资源的使用保持清晰可控。',
  },
  { icon: Headphones, title: '技术支持', body: '从资源选型到使用问题，获得清晰的技术协助。' },
];
function Capabilities() {
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
              让上云更简单，
              <span className="block text-primary">让业务更专注</span>
            </h2>

            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              从产品选型到日常使用，为你的业务提供云资源与技术协助。
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

function UseCases({ assetsBaseUrl }: { assetsBaseUrl: string }) {
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
              你的业务场景，
              <span className="block text-primary">都能从云端开始</span>
            </h2>

            <p className="mt-4 max-w-prose text-balance text-sm leading-6 tracking-tight text-muted-foreground lg:text-base">
              建站、开发、数据服务，为不同用途找到合适的云产品。
            </p>
          </Reveal>
        </div>
        <div className="my-12 grid gap-4 md:grid-cols-2">
          {[
            {
              tag: '网站与应用',
              image: 'product/product-browser-card.png',
              title: '让产品稳定在线',
              body: '为网站、API 与业务应用提供可靠的运行环境。',
            },
            {
              tag: '开发与测试',
              image: 'product/product-revenue-growth.png',
              title: '快速搭建独立环境',
              body: '为团队准备一致的开发测试资源，缩短环境交付时间。',
            },
            {
              tag: '数据与存储',
              image: 'product/product-vip-star.png',
              title: '管理业务中的关键数据',
              body: '为数据服务与持久化存储安排适合的资源配置。',
            },
            {
              tag: '企业应用',
              image: 'product/product-user-payment.png',
              title: '为业务系统准备云资源',
              body: '为办公协作、内部系统与业务服务配置运行环境。',
            },
          ].map((c) => (
            <Reveal key={c.tag} className="h-full">
              <Spotlight>
                <article className="group relative flex h-full flex-col items-start overflow-hidden rounded-xl bg-gradient-to-br from-muted/20 to-background/0 p-6 shadow-2xl shadow-primary/5 transition-shadow duration-500 hover:shadow-primary/10 lg:p-8">
                  <img src={`${assetsBaseUrl}/glass-theme/${c.image}`} width={c.image.endsWith('product-browser-card.png') ? 128 : 180} height={c.image.endsWith('product-browser-card.png') ? 128 : 180} alt="" loading="lazy" className="pointer-events-none absolute right-4 top-4 h-16 w-20 object-contain transition-transform duration-700 motion-safe:group-hover:-translate-y-1 sm:h-20 sm:w-28" />
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
                    href="/shop"
                    className="group/link mt-8 inline-flex items-center gap-2 text-sm text-primary transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring lg:text-base"
                  >
                    查看相关服务
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

function Statement() {
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
        <PlatformStories />
      </Reveal>
    </section>
  );
}

function Pricing() {
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
            按业务与预算，
            <span className="block text-primary">选择你的云服务</span>
          </h2>

          <p className="mt-4 max-w-prose text-sm leading-6 text-muted-foreground">
            浏览在售云产品，比较配置与计费周期，找到适合你的方案。
          </p>
        </Reveal>
        <div className="mx-auto mt-12 grid max-w-5xl gap-4 md:grid-cols-3">
          {[
            {
              title: '轻量起步',
              intro: '开发与测试',
              list: ['个人网站与小型应用', '开发测试环境', '按预算选择配置', '在线查看规格与价格'],
            },
            {
              title: '生产业务',
              intro: '稳定与扩展',
              list: ['网站与业务应用', '按负载选择算力', '搭配存储与数据库', '控制台管理已购服务'],
            },
            {
              title: '企业需求',
              intro: '按业务选型',
              list: ['企业业务系统', '多环境部署需求', '按业务规模选型', '产品选型与技术协助'],
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
                    <PricingInfo text="资源规格、计费周期与服务范围以商城商品详情为准。" />
                  </div>
                  <p
                    className={`mt-10 text-xs ${i === 1 ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}
                  >
                    适用需求
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
                    href="/shop"
                    className={`mt-auto inline-flex h-9 items-center justify-center rounded-full text-sm ${i === 1 ? 'bg-primary-foreground text-primary' : 'bg-primary text-primary-foreground'}`}
                  >
                    查看产品与价格
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

function Footer() {
  const groups = [
    {
      title: '应用场景',
      links: [
        ['网站与应用', '/#use-cases'],
        ['开发与测试', '/#use-cases'],
        ['数据与存储', '/#use-cases'],
        ['企业应用', '/#use-cases'],
      ],
    },
    {
      title: '产品',
      links: [
        ['云服务器', '/shop'],
        ['云存储', '/shop'],
        ['云数据库', '/shop'],
      ],
    },
    {
      title: '资源',
      links: [
        ['服务优势', '/#capabilities'],
        ['应用场景', '/#use-cases'],
        ['服务选型', '/#pricing'],
      ],
    },
    {
      title: '开始使用',
      links: [
        ['选购云产品', '/shop'],
        ['登录账户', '/login'],
        ['注册账户', '/register'],
      ],
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
              StackPanel
            </Link>
            <p className="max-w-xs text-center text-sm leading-relaxed text-muted-foreground md:text-base lg:text-left">
              提供计算、存储与数据库服务，让你的想法与业务在云端生长。
            </p>
            <nav aria-label="云服务快捷入口" className="flex items-center gap-4">
              {[
                { label: '选购云产品', href: '/shop', icon: Server },
                { label: '账户控制台', href: '/account', icon: Layers3 },
                { label: '服务优势', href: '/#capabilities', icon: ShieldCheck },
                { label: '产品与价格', href: '/#pricing', icon: Database },
              ].map((link) => (
                <Link
                  key={link.label}
                  href={link.href}
                  aria-label={link.label}
                  className="text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <link.icon aria-hidden="true" className="size-6" />
                </Link>
              ))}
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
          © 2026 StackPanel
        </Reveal>
      </div>
    </footer>
  );
}

function HomePage(props: FrontendPageProps): ReactElement {
  const assetsBaseUrl = props.assetsBaseUrl ?? '/api/plugins/themes/default/assets';
  return (
    <main className="flex-1">
      <Hero assetsBaseUrl={assetsBaseUrl} />
      <Ecosystem />
      <Features assetsBaseUrl={assetsBaseUrl} />
      <Capabilities />
      <UseCases assetsBaseUrl={assetsBaseUrl} />
      <Statement />
      <Pricing />
      <section
        data-section="cta"
        className={`${container} pb-20 pt-12 text-left lg:min-h-[316px] lg:pb-32`}
      >
        <Reveal>
          <h2 className="text-4xl font-normal tracking-tight md:text-5xl">
            为你的下一次上线，
            <span className="block text-primary">选好云资源</span>
          </h2>

          <p className="mt-4 max-w-prose text-sm leading-6 text-muted-foreground">
            挑选适合的云产品，从今天开始部署你的网站与应用。
          </p>
        </Reveal>
        <Reveal className="mt-4 flex flex-wrap gap-4">
          <ActionLink href="/shop">选购云产品</ActionLink>
          <ActionLink href="#features" outline>
            了解云产品
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
}: FrontendLayoutProps): ReactElement {
  const links = [
    { label: '云产品', href: '/#features' },
    { label: '服务优势', href: '/#capabilities' },
    { label: '应用场景', href: '/#use-cases' },
    { label: '价格', href: '/#pricing' },
    ...navigation,
  ];
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
              href={isAuthenticated ? '/account' : '/login'}
              className="hidden h-9 items-center rounded-full px-4 text-sm transition-colors hover:bg-muted lg:inline-flex"
            >
              {isAuthenticated ? '控制台' : '登录'}
            </Link>
            <ActionLink href={isAuthenticated ? '/account' : '/register'}>
              {isAuthenticated ? '进入控制台' : '开始使用'}
            </ActionLink>
          </>
        }
      />
      <div id="clarity-page-content" className="flex-1">
        {children}
      </div>
      <Footer />
      <DocumentScrollbar />
      <SmoothDocument />
    </div>
  );
}
const frontend: FrontendPackage = defineFrontend({
  layouts: { default: DefaultLayout, theme: DefaultLayout },
  overrides: { '/shop': 'shop', '/shop/:id': 'product', '/shop/cart': 'cart' },
  pages: [{ path: '/', component: 'home', layout: 'default' }],
  pageComponents: {
    home: HomePage,
    shop: ProductListPage,
    product: ProductDetailPage,
    cart: StoreCartPage,
  },
});
export default frontend;
