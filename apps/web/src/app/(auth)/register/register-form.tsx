'use client';

import { useActionState, useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { AuthShell, type AuthProvider } from '@/components/auth-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslator } from '@/i18n/provider';
import { registerAction, sendRegisterCodeAction } from '@/lib/actions';

export interface RegisterCaptchaConfig {
  mode: 'off' | 'optional' | 'required';
  configured: boolean;
  providerIds: string[];
  clientConfig: Record<string, unknown> | null;
}

export function RegisterForm({
  providers = [],
  platformName,
  platformDescription,
  logoSrc,
  affid = null,
  emailVerificationRequired = false,
  captcha = { mode: 'off', configured: false, providerIds: [], clientConfig: null },
}: {
  providers?: AuthProvider[];
  platformName: string;
  platformDescription?: string;
  logoSrc?: string | null;
  /** Referral code the visitor arrived with; carried through the form submit. */
  affid?: string | null;
  /** Whether a verified email code is required before an account is created. */
  emailVerificationRequired?: boolean;
  /** Deployment captcha policy (kernel-owned) plus provider client config. */
  captcha?: RegisterCaptchaConfig;
}) {
  const [state, action, pending] = useActionState(registerAction, {});
  const [codeState, sendCodeAction, sendingCode] = useActionState(sendRegisterCodeAction, {});
  const [showPassword, setShowPassword] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState('');
  const t = useTranslator();
  const captchaActive = captcha.mode !== 'off' && captcha.configured;

  // The provider widget (when configured) writes its token into a hidden input;
  // keep the React state in sync so the value is submitted with both actions.
  useEffect(() => {
    if (!captchaActive) return;
    const el = document.querySelector<HTMLInputElement>('input[name="captchaToken"]');
    if (!el) return;
    const handler = () => setCaptchaToken(el.value);
    el.addEventListener('input', handler);
    return () => el.removeEventListener('input', handler);
  }, [captchaActive]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const form = event.currentTarget;
    const password = (form.elements.namedItem('password') as HTMLInputElement | null)?.value;
    const confirm = (form.elements.namedItem('confirmPassword') as HTMLInputElement | null)?.value;
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
        {captchaActive ? <input type="hidden" name="captchaToken" value={captchaToken} /> : null}
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
              minLength={8}
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
        <Button type="submit" disabled={pending} className="h-10 w-full text-base">
          {pending ? t('auth.register.submitting') : t('auth.register.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
