'use client';

import Link from 'next/link';
import { Layers, LogIn } from 'lucide-react';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Button } from '@/components/ui/button';
import { localeOptions } from '@/i18n/core';
import { useLocale, useTranslator } from '@/i18n/provider';

export interface AuthProvider {
  id: string;
  name: string;
}

export interface AuthShellProps {
  mode: 'login' | 'register';
  platformName: string;
  platformDescription?: string;
  logoSrc?: string | null;
  /** Third-party login providers; the block is hidden when the list is empty. */
  providers?: AuthProvider[];
  children: React.ReactNode;
}

/**
 * Shared auth chrome for /login and /register.
 *
 * Composition mirrors https://studio-admin.arhamkhnz.com/auth/v2/login: a
 * viewport grid with an inset rounded brand panel on the right (brand block at
 * the top, two info columns at the bottom), a vertically centred 350px form
 * column with a centred heading, an optional third-party provider block with an
 * "or continue with" divider, a cross-link pinned top-right, and a footer row
 * with copyright and language switcher. Only the panel palette follows
 * https://js.design/login: a saturated pastel aurora drawn in CSS (no
 * third-party image is vendored). The decorative hues are one-off values
 * sampled from that reference and are intentionally not theme tokens, which
 * would flatten the aurora to a single brand channel.
 */
export function AuthShell({
  mode,
  platformName,
  platformDescription,
  logoSrc,
  providers = [],
  children,
}: AuthShellProps) {
  const locale = useLocale();
  const t = useTranslator();
  const isLogin = mode === 'login';
  const title = t(isLogin ? 'auth.login.title' : 'auth.register.title');
  const subtitle = t(isLogin ? 'auth.login.subtitle' : 'auth.register.subtitle');
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
    <div className="grid min-h-svh flex-1 justify-center p-2 lg:grid-cols-2">
      <div className="relative flex h-full flex-col">
        <div className="absolute right-10 top-5 hidden text-sm text-muted-foreground sm:block">
          {crossPrompt} {crossLink}
        </div>

        <div className="flex flex-1 items-center justify-center px-8 py-20">
          <div className="w-full max-w-[350px]">
            <div className="mb-8 space-y-2 text-center">
              <h1 className="text-3xl font-medium tracking-tight text-foreground">{title}</h1>
              <p className="text-sm text-muted-foreground">{subtitle}</p>
            </div>

            {providers.length > 0 ? (
              <div className="mb-6 space-y-4">
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

            <p className="mt-6 text-center text-sm text-muted-foreground sm:hidden">
              {crossPrompt} {crossLink}
            </p>
          </div>
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

      <aside className="relative hidden overflow-hidden rounded-3xl lg:flex lg:flex-col">
        {/* Pastel aurora: hues sampled from the js.design login panel. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-[#4fc9ff] via-[#7b6cff] to-[#c96cff]"
        />
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute -left-24 -top-32 size-[30rem] rounded-full bg-[#5fe0ff] opacity-90 blur-3xl" />
          <div className="absolute right-[-6rem] top-[-4rem] size-[26rem] rounded-full bg-[#5b8cff] opacity-90 blur-3xl" />
          <div className="absolute left-1/4 top-1/3 size-[24rem] rounded-full bg-[#9a6cff] opacity-80 blur-3xl" />
          <div className="absolute right-[-3rem] top-1/4 size-[22rem] rounded-full bg-[#6ef0c0] opacity-70 blur-3xl" />
          <div className="absolute right-[-2rem] top-1/2 size-[24rem] rounded-full bg-[#ffe07a] opacity-70 blur-3xl" />
          <div className="absolute right-[-4rem] bottom-[8rem] size-[26rem] rounded-full bg-[#ff7ec7] opacity-80 blur-3xl" />
          <div className="absolute bottom-[-8rem] left-1/4 size-[28rem] rounded-full bg-[#c96cff] opacity-80 blur-3xl" />
          <div className="absolute bottom-[-6rem] right-1/4 size-[24rem] rounded-full bg-[#ff9ad5] opacity-70 blur-3xl" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />
        </div>

        <div className="relative z-10 flex flex-1 flex-col p-10 text-white">
          <div className="flex items-start gap-3">
            {logoSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoSrc} alt="" className="size-10 rounded-xl bg-white/15 object-contain p-1" />
            ) : (
              <span className="flex size-10 items-center justify-center rounded-xl bg-white/15">
                <Layers className="size-5" />
              </span>
            )}
            <div className="space-y-0.5">
              <p className="text-xl font-semibold tracking-tight drop-shadow-sm">{platformName}</p>
              {platformDescription ? (
                <p className="max-w-md text-sm text-white/85 drop-shadow-sm">
                  {platformDescription}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-auto grid grid-cols-2 gap-6">
            <div className="drop-shadow-sm">
              <p className="text-base font-medium">{t('auth.panel.highlightTitle')}</p>
              <p className="mt-1 text-sm text-white/85">{t('auth.panel.highlightText')}</p>
            </div>
            <div className="border-l border-white/25 pl-6 drop-shadow-sm">
              <p className="text-base font-medium">{t('auth.panel.helpTitle')}</p>
              <p className="mt-1 text-sm text-white/85">
                {t('auth.panel.helpText')}{' '}
                <Link
                  href="/blog"
                  className="font-medium text-white underline underline-offset-4 hover:text-white/80"
                >
                  {t('auth.panel.helpLink')}
                </Link>
              </p>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
