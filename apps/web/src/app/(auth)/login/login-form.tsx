'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { Eye, EyeOff } from 'lucide-react';
import { AuthShell, type AuthPost, type AuthProvider } from '@/components/auth-shell';
import { CaptchaField } from '@/components/captcha-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslator } from '@/i18n/provider';
import type { CaptchaActionConfig } from '@/lib/captcha';
import { loginAction } from '@/lib/actions';

export function LoginForm({
  nextPath,
  oauthError = false,
  providers = [],
  platformName,
  logoSrc,
  posts = [],
  captcha = null,
  registrationEnabled = true,
  passwordResetSupported = false,
  resetSuccess = false,
}: {
  nextPath?: string;
  /** The OAuth callback redirected back with `?error=oauth`. */
  oauthError?: boolean;
  providers?: AuthProvider[];
  platformName: string;
  logoSrc?: string | null;
  posts?: AuthPost[];
  /** Widget for the `login` action, or `null` when sign-in is not guarded. */
  captcha?: CaptchaActionConfig | null;
  /** Hides the "register" cross-link when sign-ups are closed. */
  registrationEnabled?: boolean;
  /** Shows the "forgot password" link only when a reset can actually be sent. */
  passwordResetSupported?: boolean;
  /** The visitor just completed a reset (`?reset=1`). */
  resetSuccess?: boolean;
}) {
  const [state, action, pending] = useActionState(loginAction, {});
  const [showPassword, setShowPassword] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const t = useTranslator();
  const errorMessage = state.error ?? (oauthError ? t('auth.login.oauthFailed') : null);
  return (
    <AuthShell
      mode="login"
      platformName={platformName}
      logoSrc={logoSrc}
      providers={providers}
      posts={posts}
      registrationEnabled={registrationEnabled}
    >
      <form action={action} className="space-y-5">
        <input type="hidden" name="next" value={nextPath ?? ''} />
        {captchaToken ? <input type="hidden" name="captchaToken" value={captchaToken} /> : null}
        {resetSuccess ? (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
            {t('auth.reset.done')}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="email">{t('auth.login.email')}</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="py-2.5"
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="password">{t('auth.login.password')}</Label>
            {passwordResetSupported ? (
              <Link
                href="/forgot-password"
                className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                {t('auth.login.forgotPassword')}
              </Link>
            ) : null}
          </div>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              required
              className="py-2.5 pr-9"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={
                showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')
              }
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
        <CaptchaField config={captcha?.clientConfig ?? null} onToken={setCaptchaToken} />
        <Button type="submit" disabled={pending} className="h-10 w-full text-base">
          {pending ? t('auth.login.submitting') : t('auth.login.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
