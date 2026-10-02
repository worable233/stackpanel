'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { localeOptions } from '@/i18n/core';
import { useLocale, useTranslator } from '@/i18n/provider';
import { loginAction } from '@/lib/actions';

export function LoginForm({
  nextPath,
  hasWowId = false,
}: {
  nextPath?: string;
  hasWowId?: boolean;
}) {
  const [state, action, pending] = useActionState(loginAction, {});
  const [showPassword, setShowPassword] = useState(false);
  const locale = useLocale();
  const t = useTranslator();
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <form
        action={action}
        className="w-full max-w-sm space-y-5 rounded-lg border bg-card p-6 text-card-foreground shadow-sm"
      >
        <div className="flex justify-end">
          <LocaleSwitcher
            locale={locale}
            items={localeOptions()}
            ariaLabel={t('localeSwitcher.ariaLabel')}
          />
        </div>
        <input type="hidden" name="next" value={nextPath ?? ''} />
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('auth.login.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('auth.login.subtitle')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">{t('auth.login.email')}</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t('auth.login.password')}</Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              className="pr-9"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
        {hasWowId ? (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {t('auth.login.or')}
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button
              variant="outline"
              className="w-full"
              render={<Link href="/auth/oauth/wowid/start" />}
            >
              {t('auth.login.wowid')}
            </Button>
          </>
        ) : null}
        <p className="text-center text-sm text-muted-foreground">
          {t('auth.login.noAccount')}
          <Link className="text-foreground underline underline-offset-4" href="/register">
            {t('auth.login.register')}
          </Link>
        </p>
      </form>
    </main>
  );
}
