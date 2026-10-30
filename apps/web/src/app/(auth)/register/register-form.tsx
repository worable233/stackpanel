'use client';

import { useActionState, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, validatePassword } from '@stackpanel/sdk';
import { AuthShell, type AuthProvider } from '@/components/auth-shell';
import { CaptchaField } from '@/components/captcha-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslator } from '@/i18n/provider';
import type { CaptchaActionConfig } from '@/lib/captcha';
import { registerAction, sendRegisterCodeAction } from '@/lib/actions';

export function RegisterForm({
  providers = [],
  platformName,
  platformDescription,
  logoSrc,
  affid = null,
  emailVerificationRequired = false,
  captcha = null,
  sendCodeCaptcha = null,
}: {
  providers?: AuthProvider[];
  platformName: string;
  platformDescription?: string;
  logoSrc?: string | null;
  /** Referral code the visitor arrived with; carried through the form submit. */
  affid?: string | null;
  /** Whether a verified email code is required before an account is created. */
  emailVerificationRequired?: boolean;
  /** Widget for the `register` action, or `null` when sign-up is not guarded. */
  captcha?: CaptchaActionConfig | null;
  /** Widget for the `register_send_code` action (guardable independently). */
  sendCodeCaptcha?: CaptchaActionConfig | null;
}) {
  const [state, action, pending] = useActionState(registerAction, {});
  const [codeState, sendCodeAction, sendingCode] = useActionState(sendRegisterCodeAction, {});
  const [showPassword, setShowPassword] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const t = useTranslator();

  /**
   * One widget serves both submitting actions. The two actions are policy-
   * independent (a deployment may guard sign-up but not the code request), so
   * the widget renders whenever *either* is guarded and the same token is
   * submitted with both — the kernel ignores it for whichever action is `off`.
   * Register wins when both are on because it is the form's primary action.
   */
  const activeCaptcha = captcha ?? sendCodeCaptcha;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const email = (form.elements.namedItem('email') as HTMLInputElement | null)?.value ?? '';
    const password = (form.elements.namedItem('password') as HTMLInputElement | null)?.value ?? '';
    const confirm = (form.elements.namedItem('confirmPassword') as HTMLInputElement | null)?.value;
    // Same rule set as the kernel, evaluated in the browser: the visitor gets the
    // reason immediately (and in their language) instead of after a round trip.
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
    <AuthShell
      mode="register"
      platformName={platformName}
      platformDescription={platformDescription}
      logoSrc={logoSrc}
      providers={providers}
    >
      <form action={action} onSubmit={handleSubmit} className="space-y-5">
        {affid ? <input type="hidden" name="affid" value={affid} /> : null}
        {captchaToken ? <input type="hidden" name="captchaToken" value={captchaToken} /> : null}
        <div className="space-y-2">
          <Label htmlFor="email">{t('auth.register.email')}</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="py-2.5"
          />
        </div>
        {emailVerificationRequired ? (
          <div className="space-y-2">
            <Label htmlFor="code">{t('auth.register.code')}</Label>
            <div className="flex gap-2">
              <Input
                id="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
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
                {sendingCode ? t('auth.register.sendingCode') : t('auth.register.sendCode')}
              </Button>
            </div>
            {codeState.notice ? (
              <p className="text-sm text-muted-foreground">
                {codeState.codeSentTo
                  ? t('auth.register.codeSentTo', { email: codeState.codeSentTo })
                  : codeState.notice}
              </p>
            ) : null}
            {codeState.error ? <p className="text-sm text-destructive">{codeState.error}</p> : null}
          </div>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="password">{t('auth.register.password')}</Label>
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
          <Label htmlFor="confirmPassword">{t('auth.register.confirmPassword')}</Label>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            required
            className="py-2.5"
            aria-invalid={confirmError ? true : undefined}
          />
        </div>
        {confirmError ? <p className="text-sm text-destructive">{confirmError}</p> : null}
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        <CaptchaField config={activeCaptcha?.clientConfig ?? null} onToken={setCaptchaToken} />
        <Button type="submit" disabled={pending} className="h-10 w-full text-base">
          {pending ? t('auth.register.submitting') : t('auth.register.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
