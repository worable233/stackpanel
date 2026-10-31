'use client';

import { useActionState, useEffect, useState } from 'react';
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

/** Mirrors the kernel default for `AUTH_CODE_SEND_COOLDOWN_SECONDS`. */
const SEND_CODE_COOLDOWN_SECONDS = 60;

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
  /** Token of the `register_send_code` widget; the two actions are guarded separately. */
  const [sendCodeToken, setSendCodeToken] = useState<string | null>(null);
  /**
   * Client-side echo of the kernel's per-recipient cooldown
   * (`AUTH_CODE_SEND_COOLDOWN_SECONDS`, 60s by default). The server is the
   * authority; this only stops the visitor from discovering the limit by
   * hammering the button — and shows how long the wait is.
   */
  const [cooldown, setCooldown] = useState(0);
  /** Client-side refusal for the send-code button (empty email, unsolved widget). */
  const [sendCodeError, setSendCodeError] = useState<string | null>(null);
  /** Client-side refusal for the sign-up button (unsolved widget). */
  const [captchaError, setCaptchaError] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    // Only a *delivered* code starts the countdown. Starting it on an error made a
    // rejected request (missing email, unsolved widget) look like "sent — wait 53s",
    // which is worse than no feedback at all.
    if (codeState.notice) setCooldown(SEND_CODE_COOLDOWN_SECONDS);
  }, [codeState]);
  const t = useTranslator();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    // "获取验证码" is a second submit button on the same form, and it only sends an
    // email — it never creates the account. Running the password rules for it made
    // the button do nothing at all while the password fields were still empty
    // (native `required` on code/password + this handler), so a visitor who asked
    // for the code first could not get one.
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    if (submitter?.dataset.sendCode === 'true') {
      setPasswordError(null);
      setConfirmError(null);
      // Native constraint validation does not run for React form actions, so the
      // send-code button has to refuse on its own: without this the browser posted
      // an empty email (and an unsolved widget) and only the server said no.
      const emailInput = event.currentTarget.elements.namedItem('email') as HTMLInputElement | null;
      const email = emailInput?.value.trim() ?? '';
      if (!email) {
        event.preventDefault();
        setSendCodeError(t('auth.validation.emailRequired'));
        return;
      }
      if (emailInput && !emailInput.validity.valid) {
        event.preventDefault();
        setSendCodeError(t('auth.validation.emailInvalid'));
        return;
      }
      if (sendCodeCaptcha?.policy === 'required' && !sendCodeToken) {
        event.preventDefault();
        setSendCodeError(t('error.auth.captcha_required'));
        return;
      }
      setSendCodeError(null);
      return;
    }
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
    // The kernel enforces this too, but answering here keeps the visitor from
    // paying a round trip (and from reading a server 400 as "the form is broken").
    if (captcha?.policy === 'required' && !captchaToken) {
      event.preventDefault();
      setCaptchaError(t('error.auth.captcha_required'));
      return;
    }
    setConfirmError(null);
    setCaptchaError(null);
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
            onChange={() => setSendCodeError(null)}
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
                formNoValidate
                data-send-code="true"
                disabled={sendingCode || cooldown > 0}
                variant="outline"
                className="h-auto shrink-0 whitespace-nowrap"
              >
                {sendingCode
                  ? t('auth.register.sendingCode')
                  : cooldown > 0
                    ? t('auth.register.resendIn', { seconds: cooldown })
                    : t('auth.register.sendCode')}
              </Button>
            </div>
            {codeState.notice ? (
              <p className="text-sm text-muted-foreground">
                {codeState.codeSentTo
                  ? t('auth.register.codeSentTo', { email: codeState.codeSentTo })
                  : codeState.notice}
              </p>
            ) : null}
            {sendCodeError ? (
              <p className="text-sm text-destructive">{sendCodeError}</p>
            ) : (
              codeState.error && <p className="text-sm text-destructive">{codeState.error}</p>
            )}
            {sendCodeToken ? (
              <input type="hidden" name="sendCodeCaptchaToken" value={sendCodeToken} />
            ) : null}
            {/*
              Its own widget, bound to `register_send_code`: a CAPTCHA token is
              minted for one action only, so reusing the sign-up widget's token
              here made the kernel reject a legitimately solved code request.
            */}
            <CaptchaField
              config={sendCodeCaptcha?.clientConfig ?? null}
              onToken={setSendCodeToken}
              fieldName="altcha_send_code"
            />
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
        <CaptchaField
          config={captcha?.clientConfig ?? null}
          onToken={(token) => {
            setCaptchaToken(token);
            if (token) setCaptchaError(null);
          }}
        />
        {captchaError ? <p className="text-sm text-destructive">{captchaError}</p> : null}
        <Button type="submit" disabled={pending} className="h-10 w-full text-base">
          {pending ? t('auth.register.submitting') : t('auth.register.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
