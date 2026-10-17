'use client';

import Link from 'next/link';
import { ArrowUpRight, Layers, LogIn } from 'lucide-react';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Button } from '@/components/ui/button';
import { Reveal, HeroRays } from '@stackpanel/ui';
import { localeOptions } from '@/i18n/core';
import { useLocale, useTranslator } from '@/i18n/provider';

export interface AuthProvider {
  id: string;
  name: string;
}

export interface AuthPost {
  title: string;
  excerpt: string;
  path: string;
  publishedAt?: string | null;
}

export interface AuthShellProps {
  mode: 'login' | 'register' | 'setup';
  platformName: string;
  platformDescription?: string;
  logoSrc?: string | null;
  /** Third-party login providers; the block is hidden when the list is empty. */
  providers?: AuthProvider[];
  posts?: AuthPost[];
  children: React.ReactNode;
}

/** Standalone authentication: centered form and inset brand panel. */
export function AuthShell({
  mode,
  platformName,
  logoSrc,
  providers = [],
  posts = [],
  children,
}: AuthShellProps) {
  const locale = useLocale();
  const t = useTranslator();
  const isLogin = mode === 'login';
  const isSetup = mode === 'setup';
  const title = t(
    isSetup ? 'auth.setup.title' : isLogin ? 'auth.login.title' : 'auth.register.title',
  );
  const subtitle = t(
    isSetup ? 'auth.setup.subtitle' : isLogin ? 'auth.login.subtitle' : 'auth.register.subtitle',
  );
  const crossPrompt = t(isLogin ? 'auth.login.noAccount' : 'auth.register.hasAccount');
  const crossAction = t(isLogin ? 'auth.login.register' : 'auth.register.login');
  const crossHref = isLogin ? '/register' : '/login';

  const crossLink = (
    <Link
      href={crossHref}
      className="font-medium text-foreground underline-offset-4 hover:underline"
    >
      {crossAction}
    </Link>
  );

  return (
    <div className="grid min-h-svh w-full flex-1 p-3 lg:grid-cols-2 lg:gap-3">
      <div className="relative flex h-full flex-col">
        {!isSetup ? (
          <div className="absolute right-6 top-5 hidden text-sm text-muted-foreground sm:block">
            {crossPrompt} {crossLink}
          </div>
        ) : null}

        <div className="flex flex-1 items-center justify-center px-5 pb-24 pt-28 sm:px-12 sm:py-28">
          <Reveal className="w-full max-w-[350px]">
            <div className="mb-8 flex flex-col gap-2 text-center">
              <h1 className="text-3xl font-medium tracking-tight text-foreground">{title}</h1>
              <p className="text-sm text-muted-foreground">{subtitle}</p>
            </div>

            {!isSetup && providers.length > 0 ? (
              <div className="mb-6 flex flex-col gap-4">
                <div className="grid gap-2">
                  {providers.map((provider) => (
                    <Button
                      key={provider.id}
                      variant="outline"
                      className="h-10 w-full text-base"
                      render={<Link href={`/auth/oauth/${provider.id}/start`} />}
                    >
                      <LogIn className="size-4" aria-hidden />
                      {t('auth.login.continueWith', { name: provider.name })}
                    </Button>
                  ))}
                </div>
                <div className="relative text-center text-sm text-muted-foreground">
                  <span className="relative z-10 bg-background px-2">
                    {t('auth.login.orContinueWith')}
                  </span>
                  <span
                    aria-hidden
                    className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border"
                  />
                </div>
              </div>
            ) : null}

            {children}

            {!isSetup ? (
              <p className="mt-6 text-center text-sm text-muted-foreground sm:hidden">
                {crossPrompt} {crossLink}
              </p>
            ) : null}
          </Reveal>
        </div>

        <div className="absolute bottom-5 flex w-full items-center justify-between px-10">
          <p className="hidden text-sm text-muted-foreground sm:block">
            {t('auth.legal.copyrightCompact', { name: platformName })}
          </p>
          <LocaleSwitcher
            locale={locale}
            items={localeOptions()}
            ariaLabel={t('localeSwitcher.ariaLabel')}
          />
        </div>
      </div>

      <aside className="relative hidden overflow-hidden rounded-3xl border border-foreground/10 bg-foreground/[0.025] lg:flex lg:flex-col">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 [background:radial-gradient(ellipse_at_50%_30%,color-mix(in_oklch,var(--primary)_18%,transparent),transparent_70%)]"
        />
        <HeroRays />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-20 [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:linear-gradient(to_bottom,transparent,black,transparent)]"
        />
        <div className="relative flex flex-1 flex-col gap-10 p-8 xl:p-12">
          <Reveal>
            <Link
              href="/"
              className="inline-flex items-center gap-3 text-xl font-semibold tracking-tight"
            >
              {logoSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoSrc} alt="" className="size-9 object-contain" />
              ) : (
                <Layers className="size-8 text-primary" aria-hidden />
              )}
              {platformName}
            </Link>
          </Reveal>
          <Reveal className="flex flex-1 flex-col justify-center py-10">
            <h2 className="text-4xl font-medium leading-tight tracking-tight xl:text-5xl">
              你的业务，
              <br />
              <span className="text-muted-foreground">即刻上云。</span>
            </h2>
          </Reveal>
          {posts.length > 0 ? (
            <Reveal className="flex flex-col gap-4">
              <p className="text-xs font-medium text-muted-foreground">最新文章</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                {posts.slice(0, 2).map((post) => (
                  <Link
                    key={post.path}
                    href={post.path}
                    className="group rounded-xl border border-foreground/10 bg-background/25 p-4 backdrop-blur-xl transition-colors hover:border-primary/30 hover:bg-background/40"
                  >
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <h3 className="line-clamp-2 text-sm font-medium leading-6">{post.title}</h3>
                      <ArrowUpRight
                        className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
                        aria-hidden
                      />
                    </div>
                    {post.excerpt ? (
                      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {post.excerpt}
                      </p>
                    ) : null}
                  </Link>
                ))}
              </div>
            </Reveal>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
