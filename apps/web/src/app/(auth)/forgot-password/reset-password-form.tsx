'use client';

import { useActionState, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, validatePassword } from '@stackpanel/sdk';
import { AuthShell } from '@/components/auth-shell';
import { CaptchaField } from '@/components/captcha-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslator } from '@/i18n/provider';
import type { CaptchaActionConfig } from '@/lib/captcha';
import { requestPasswordResetAction, resetPasswordAction } from '@/lib/actions';

/**
 * Self-service password reset in one screen: ask for a code, then spend it.
 *
 * Keeping both steps on one page is deliberate — the code is short-lived, and a
 * separate page would need to smuggle the address through the URL and strand the
 * visitor when they mistype it.
 */
export function ResetPasswordForm({
  platformName,
  logoSrc,
  captcha = null,
}: {
  platformName: string;
  logoSrc?: string | null;
  /** Widget for the `password_reset` action, when the deployment guards it. */
  captcha?: CaptchaActionConfig | null;
}) {
  const [codeState, sendCodeAction, sendingCode] = useActionState(requestPasswordResetAction, {});
  const [state, action, pending] = useActionState(resetPasswordAction, {});
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const t = useTranslator();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const email = (form.elements.namedItem('email') as HTMLInputElement | null)?.value ?? '';
    const password = (form.elements.namedItem('password') as HTMLInputElement | null)?.value ?? '';
    const confirm = (form.elements.namedItem('confirmPassword') as HTMLInputElement | null)?.value;
    const policy = validatePassword(password, { email });
    if (!policy.ok) {
      event.preventDefault();
      setConfirmError(null);
      setPasswordError(t(`error.${policy.code}`));
      return;
    }
    setPasswordError(null);
    if (password !== confirm) {
      event.preventDefault();
      setConfirmError(t('auth.validation.passwordMismatch'));
      return;
    }
    setConfirmError(null);
  }

  return (
    <AuthShell mode="reset" platformName={platformName} logoSrc={logoSrc}>
      <form action={action} onSubmit={handleSubmit} className="space-y-5">
        {captchaToken ? <input type="hidden" name="captchaToken" value={captchaToken} /> : null}
        <div className="space-y-2">
          <Label htmlFor="email">{t('auth.reset.email')}</Label>
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
          <Label htmlFor="code">{t('auth.reset.code')}</Label>
          <div className="flex gap-2">
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={16}
              className="py-2.5"
            />
            <Button
              type="submit"
              formAction={sendCodeAction}
              disabled={sendingCode}
              variant="outline"
              className="h-auto shrink-0 whitespace-nowrap"
            >
              {sendingCode ? t('auth.reset.sendingCode') : t('auth.reset.sendCode')}
            </Button>
          </div>
          {codeState.notice ? (
            <p className="text-sm text-muted-foreground">{codeState.notice}</p>
          ) : null}
          {codeState.error ? <p className="text-sm text-destructive">{codeState.error}</p> : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t('auth.reset.newPassword')}</Label>
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              aria-invalid={passwordError ? true : undefined}
              className="py-2.5 pr-9"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={
                showPassword ? t('auth.register.hidePassword') : t('auth.register.showPassword')
              }
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('auth.password.hint', { min: PASSWORD_MIN_LENGTH })}
          </p>
          {passwordError ? <p className="text-sm text-destructive">{passwordError}</p> : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">{t('auth.reset.confirmPassword')}</Label>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            required
            aria-invalid={confirmError ? true : undefined}
            className="py-2.5"
          />
          {confirmError ? <p className="text-sm text-destructive">{confirmError}</p> : null}
        </div>
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        <CaptchaField config={captcha?.clientConfig ?? null} onToken={setCaptchaToken} />
        <Button type="submit" disabled={pending} className="h-10 w-full text-base">
          {pending ? t('auth.reset.submitting') : t('auth.reset.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
