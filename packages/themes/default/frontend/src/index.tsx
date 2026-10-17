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
import { t, messages } from './i18n.js';

type Translator = ReturnType<typeof t>;

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

function Hero({ settings, tr }: { settings?: FrontendSettings; tr: Translator }) {
  const badge = setting(settings, 'hero', 'badge', tr('content.hero.badge'));
  const titleLine1 = setting(settings, 'hero', 'titleLine1', tr('content.hero.titleLine1'));
  const titleLine2 = setting(settings, 'hero', 'titleLine2', tr('content.hero.titleLine2'));
  const description = setting(settings, 'hero', 'description', tr('content.hero.description'));
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
                {setting(settings, 'hero', 'badgeLabel', tr('content.hero.badgeLabel'))}
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
                text={setting(settings, 'hero', 'highlight', tr('content.hero.highlight'))}
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
                {setting(settings, 'hero', 'primaryLabel', tr('content.hero.primaryLabel'))}
              </ActionLink>
              <ActionLink href={setting(settings, 'hero', 'secondaryHref', '#features')} outline>
                {setting(settings, 'hero', 'secondaryLabel', tr('content.hero.secondaryLabel'))}
              </ActionLink>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Ecosystem({ settings, tr }: { settings?: FrontendSettings; tr: Translator }) {
  return (
    <section data-section="ecosystem" className="relative py-12 md:py-16 lg:min-h-[220px]">
      <div className={`${container} group/ecosystem relative`}>
        <Reveal>
          <p className="text-center text-sm text-muted-foreground">
            {setting(settings, 'ecosystem', 'text1', tr('content.ecosystem.text1'))}
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
                    tr('content.ecosystem.technologies.0.label'),
                    tr('content.ecosystem.technologies.1.label'),
                    tr('content.ecosystem.technologies.2.label'),
                    tr('content.ecosystem.technologies.3.label'),
                    tr('content.ecosystem.technologies.4.label'),
                    tr('content.ecosystem.technologies.5.label'),
                    tr('content.ecosystem.technologies.6.label'),
                    tr('content.ecosystem.technologies.7.label'),
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
          {setting(settings, 'ecosystem', 'copy1', tr('content.ecosystem.copy1'))}
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </section>
  );
}

function Features({
  assetsBaseUrl,
  settings,
  tr,
}: {
  assetsBaseUrl: string;
  settings?: FrontendSettings;
  tr: Translator;
}) {
  const features = [
    {
      title: setting(settings, 'features', 'text1', tr('content.features.text1')),
      body: setting(settings, 'features', 'text2', tr('content.features.text2')),
      points: [
        setting(settings, 'features', 'text3', tr('content.features.text3')),
        setting(settings, 'features', 'text4', tr('content.features.text4')),
        setting(settings, 'features', 'text5', tr('content.features.text5')),
      ],
      image: 'feature/feature-elastic-compute.png',
    },
    {
      title: setting(settings, 'features', 'text6', tr('content.features.text6')),
      body: setting(settings, 'features', 'text7', tr('content.features.text7')),
      points: [],
      image: 'feature/feature-simple-management.png',
    },
    {
      title: setting(settings, 'features', 'text8', tr('content.features.text8')),
      body: setting(settings, 'features', 'text9', tr('content.features.text9')),
      points: [
        setting(settings, 'features', 'text10', tr('content.features.text10')),
        setting(settings, 'features', 'text11', tr('content.features.text11')),
        setting(settings, 'features', 'text12', tr('content.features.text12')),
      ],
      image: 'feature/feature-secure-network.png',
    },
    {
      title: setting(settings, 'features', 'text13', tr('content.features.text13')),
      body: setting(settings, 'features', 'text14', tr('content.features.text14')),
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
                {setting(settings, 'features', 'copy1', tr('content.features.copy1'))}
                <br />
                <span className="text-primary">
                  {setting(settings, 'features', 'text15', tr('content.features.text15'))}
                </span>
              </h2>

              <p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">
                {setting(settings, 'features', 'copy2', tr('content.features.copy2'))}
              </p>
            </Reveal>
          </div>
          <Reveal>
            <ActionLink href={setting(settings, 'features', 'link16', '/shop')} outline>
              {setting(settings, 'features', 'copy3', tr('content.features.copy3'))}
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

function Capabilities({ settings, tr }: { settings?: FrontendSettings; tr: Translator }) {
  const capabilities: Array<{ icon: LucideIcon; title: string; body: string }> = [
    {
      icon: Server,
      title: setting(settings, 'capabilities', 'text1', tr('content.capabilities.text1')),
      body: setting(settings, 'capabilities', 'text2', tr('content.capabilities.text2')),
    },
    {
      icon: Network,
      title: setting(settings, 'capabilities', 'text3', tr('content.capabilities.text3')),
      body: setting(settings, 'capabilities', 'text4', tr('content.capabilities.text4')),
    },
    {
      icon: Database,
      title: setting(settings, 'capabilities', 'text5', tr('content.capabilities.text5')),
      body: setting(settings, 'capabilities', 'text6', tr('content.capabilities.text6')),
    },
    {
      icon: Activity,
      title: setting(settings, 'capabilities', 'text7', tr('content.capabilities.text7')),
      body: setting(settings, 'capabilities', 'text8', tr('content.capabilities.text8')),
    },
    {
      icon: ShieldCheck,
      title: setting(settings, 'capabilities', 'text9', tr('content.capabilities.text9')),
      body: setting(settings, 'capabilities', 'text10', tr('content.capabilities.text10')),
    },
    {
      icon: Headphones,
      title: setting(settings, 'capabilities', 'text11', tr('content.capabilities.text11')),
      body: setting(settings, 'capabilities', 'text12', tr('content.capabilities.text12')),
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
              {setting(settings, 'capabilities', 'copy1', tr('content.capabilities.copy1'))}
              <span className="block text-primary">
                {setting(settings, 'capabilities', 'text13', tr('content.capabilities.text13'))}
              </span>
            </h2>

            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              {setting(settings, 'capabilities', 'copy2', tr('content.capabilities.copy2'))}
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
  tr,
}: {
  assetsBaseUrl: string;
  settings?: FrontendSettings;
  tr: Translator;
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
              {setting(settings, 'useCases', 'copy1', tr('content.useCases.copy1'))}
              <span className="block text-primary">
                {setting(settings, 'useCases', 'text1', tr('content.useCases.text1'))}
              </span>
            </h2>

            <p className="mt-4 max-w-prose text-balance text-sm leading-6 tracking-tight text-muted-foreground lg:text-base">
              {setting(settings, 'useCases', 'copy2', tr('content.useCases.copy2'))}
            </p>
          </Reveal>
        </div>
        <div className="my-12 grid gap-4 md:grid-cols-2">
          {[
            {
              tag: setting(settings, 'useCases', 'text2', tr('content.useCases.text2')),
              image: 'product/product-browser-card.png',
              title: setting(settings, 'useCases', 'text3', tr('content.useCases.text3')),
              body: setting(settings, 'useCases', 'text4', tr('content.useCases.text4')),
            },
            {
              tag: setting(settings, 'useCases', 'text5', tr('content.useCases.text5')),
              image: 'product/product-revenue-growth.png',
              title: setting(settings, 'useCases', 'text6', tr('content.useCases.text6')),
              body: setting(settings, 'useCases', 'text7', tr('content.useCases.text7')),
            },
            {
              tag: setting(settings, 'useCases', 'text8', tr('content.useCases.text8')),
              image: 'product/product-vip-star.png',
              title: setting(settings, 'useCases', 'text9', tr('content.useCases.text9')),
              body: setting(settings, 'useCases', 'text10', tr('content.useCases.text10')),
            },
            {
              tag: setting(settings, 'useCases', 'text11', tr('content.useCases.text11')),
              image: 'product/product-user-payment.png',
              title: setting(settings, 'useCases', 'text12', tr('content.useCases.text12')),
              body: setting(settings, 'useCases', 'text13', tr('content.useCases.text13')),
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
                    {setting(settings, 'useCases', 'copy3', tr('content.useCases.copy3'))}
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

function Statement({ settings, tr }: { settings?: FrontendSettings; tr: Translator }) {
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
          actionLabel={setting(
            settings,
            'stories',
            'actionLabel',
            tr('content.stories.actionLabel'),
          )}
          actionHref={setting(settings, 'stories', 'actionHref', '#features')}
          labels={{
            roleDescription: tr('theme.stories.roleDescription'),
            regionLabel: tr('theme.stories.regionLabel'),
            slideControlAria: tr('theme.stories.slideControlAria'),
          }}
        />
      </Reveal>
    </section>
  );
}

function Pricing({ settings, tr }: { settings?: FrontendSettings; tr: Translator }) {
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
            {setting(settings, 'pricing', 'copy1', tr('content.pricing.copy1'))}
            <span className="block text-primary">
              {setting(settings, 'pricing', 'text1', tr('content.pricing.text1'))}
            </span>
          </h2>

          <p className="mt-4 max-w-prose text-sm leading-6 text-muted-foreground">
            {setting(settings, 'pricing', 'copy2', tr('content.pricing.copy2'))}
          </p>
        </Reveal>
        <div className="mx-auto mt-12 grid max-w-5xl gap-4 md:grid-cols-3">
          {[
            {
              title: setting(settings, 'pricing', 'text2', tr('content.pricing.text2')),
              intro: setting(settings, 'pricing', 'text3', tr('content.pricing.text3')),
              list: [
                setting(settings, 'pricing', 'text4', tr('content.pricing.text4')),
                setting(settings, 'pricing', 'text5', tr('content.pricing.text5')),
                setting(settings, 'pricing', 'text6', tr('content.pricing.text6')),
                setting(settings, 'pricing', 'text7', tr('content.pricing.text7')),
              ],
            },
            {
              title: setting(settings, 'pricing', 'text8', tr('content.pricing.text8')),
              intro: setting(settings, 'pricing', 'text9', tr('content.pricing.text9')),
              list: [
                setting(settings, 'pricing', 'text10', tr('content.pricing.text10')),
                setting(settings, 'pricing', 'text11', tr('content.pricing.text11')),
                setting(settings, 'pricing', 'text12', tr('content.pricing.text12')),
                setting(settings, 'pricing', 'text13', tr('content.pricing.text13')),
              ],
            },
            {
              title: setting(settings, 'pricing', 'text14', tr('content.pricing.text14')),
              intro: setting(settings, 'pricing', 'text15', tr('content.pricing.text15')),
              list: [
                setting(settings, 'pricing', 'text16', tr('content.pricing.text16')),
                setting(settings, 'pricing', 'text17', tr('content.pricing.text17')),
                setting(settings, 'pricing', 'text18', tr('content.pricing.text18')),
                setting(settings, 'pricing', 'text19', tr('content.pricing.text19')),
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
                      text={setting(settings, 'pricing', 'text20', tr('content.pricing.text20'))}
                      ariaLabel={tr('theme.pricing.infoAria')}
                    />
                  </div>
                  <p
                    className={`mt-10 text-xs ${i === 1 ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}
                  >
                    {setting(settings, 'pricing', 'copy3', tr('content.pricing.copy3'))}
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
                    {setting(settings, 'pricing', 'copy4', tr('content.pricing.copy4'))}
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

function Footer({
  settings,
  brandName,
  tr,
}: {
  settings?: FrontendSettings;
  brandName: string;
  tr: Translator;
}) {
  const groups = [
    {
      title: setting(settings, 'footer', 'column1Title', tr('content.footer.column1Title')),
      links: settingLinks(settings, 'footer', 'column1Links', [
        [tr('content.footer.column1Links.0.label'), '/#use-cases'],
        [tr('content.footer.column1Links.1.label'), '/#use-cases'],
        [tr('content.footer.column1Links.2.label'), '/#use-cases'],
        [tr('content.footer.column1Links.3.label'), '/#use-cases'],
      ]),
    },
    {
      title: setting(settings, 'footer', 'column2Title', tr('content.footer.column2Title')),
      links: settingLinks(settings, 'footer', 'column2Links', [
        [tr('content.footer.column2Links.0.label'), '/shop'],
        [tr('content.footer.column2Links.1.label'), '/shop'],
        [tr('content.footer.column2Links.2.label'), '/shop'],
      ]),
    },
    {
      title: setting(settings, 'footer', 'column3Title', tr('content.footer.column3Title')),
      links: settingLinks(settings, 'footer', 'column3Links', [
        [tr('content.footer.column3Links.0.label'), '/#capabilities'],
        [tr('content.footer.column3Links.1.label'), '/#use-cases'],
        [tr('content.footer.column3Links.2.label'), '/#pricing'],
      ]),
    },
    {
      title: setting(settings, 'footer', 'column4Title', tr('content.footer.column4Title')),
      links: settingLinks(settings, 'footer', 'column4Links', [
        [tr('content.footer.column4Links.0.label'), '/shop'],
        [tr('content.footer.column4Links.1.label'), '/login'],
        [tr('content.footer.column4Links.2.label'), '/register'],
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
              {setting(settings, 'footer', 'description', tr('content.footer.description'))}
            </p>
            <nav aria-label={tr('theme.footer.quickNavAria')} className="flex items-center gap-4">
              {settingLinks(settings, 'footer', 'links', [
                [tr('content.footer.links.0.label'), '/shop'],
                [tr('content.footer.links.1.label'), '/account'],
                [tr('content.footer.links.2.label'), '/#capabilities'],
                [tr('content.footer.links.3.label'), '/#pricing'],
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
            aria-label={tr('theme.footer.navAria')}
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
  const tr = t(props.locale);
  return (
    <main className="flex-1">
      <Hero settings={settings} tr={tr} />
      <Ecosystem settings={settings} tr={tr} />
      <Features assetsBaseUrl={assetsBaseUrl} settings={settings} tr={tr} />
      <Capabilities settings={settings} tr={tr} />
      <UseCases assetsBaseUrl={assetsBaseUrl} settings={settings} tr={tr} />
      <Statement settings={settings} tr={tr} />
      <Pricing settings={settings} tr={tr} />
      <section
        data-section="cta"
        className={`${container} pb-20 pt-12 text-left lg:min-h-[316px] lg:pb-32`}
      >
        <Reveal>
          <h2 className="text-4xl font-normal tracking-tight md:text-5xl">
            {setting(settings, 'cta', 'copy1', tr('content.cta.copy1'))}
            <span className="block text-primary">
              {setting(settings, 'cta', 'text1', tr('content.cta.text1'))}
            </span>
          </h2>

          <p className="mt-4 max-w-prose text-sm leading-6 text-muted-foreground">
            {setting(settings, 'cta', 'copy2', tr('content.cta.copy2'))}
          </p>
        </Reveal>
        <Reveal className="mt-4 flex flex-wrap gap-4">
          <ActionLink href={setting(settings, 'cta', 'link2', '/shop')}>
            {setting(settings, 'cta', 'text3', tr('content.cta.text3'))}
          </ActionLink>
          <ActionLink href={setting(settings, 'cta', 'link4', '#features')} outline>
            {setting(settings, 'cta', 'copy3', tr('content.cta.copy3'))}
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
  locale,
}: FrontendLayoutProps): ReactElement {
  const tr = t(locale);
  const links = settingLinks(settings, 'navigation', 'links', [
    [tr('content.navigation.links.0.label'), '/#features'],
    [tr('content.navigation.links.1.label'), '/#capabilities'],
    [tr('content.navigation.links.2.label'), '/#use-cases'],
    [tr('content.navigation.links.3.label'), '/#pricing'],
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
        labels={{
          primary: tr('theme.nav.primaryAria'),
          open: tr('theme.nav.openMenu'),
          close: tr('theme.nav.closeMenu'),
        }}
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
                ? setting(
                    settings,
                    'navigation',
                    'consoleLabel',
                    tr('content.navigation.consoleLabel'),
                  )
                : setting(
                    settings,
                    'navigation',
                    'loginLabel',
                    tr('content.navigation.loginLabel'),
                  )}
            </Link>
            <ActionLink
              href={
                isAuthenticated
                  ? setting(settings, 'navigation', 'consoleHref', '/account')
                  : setting(settings, 'navigation', 'registerHref', '/register')
              }
            >
              {isAuthenticated
                ? setting(
                    settings,
                    'navigation',
                    'consoleActionLabel',
                    tr('content.navigation.consoleActionLabel'),
                  )
                : setting(
                    settings,
                    'navigation',
                    'registerLabel',
                    tr('content.navigation.registerLabel'),
                  )}
            </ActionLink>
          </>
        }
      />
      <div id="clarity-page-content" className="flex-1">
        {children}
      </div>
      <Footer settings={settings} brandName={platform.name || 'StackPanel'} tr={tr} />
      <DocumentScrollbar
        labels={{
          track: tr('theme.scrollbar.trackAria'),
          thumb: tr('theme.scrollbar.thumbAria'),
        }}
      />
      <SmoothDocument />
    </div>
  );
}
const frontend: FrontendPackage = defineFrontend({
  locales: ['zh-CN', 'en-US'],
  messages,
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
