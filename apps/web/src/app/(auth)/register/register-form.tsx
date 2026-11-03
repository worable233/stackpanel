'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, validatePassword } from '@stackpanel/sdk';
import { AuthShell, type AuthProvider } from '@/components/auth-shell';
import { CaptchaField } from '@/components/captcha-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cooldownSignalFor, useCooldown } from '@/hooks/use-cooldown';
import { useTranslator } from '@/i18n/provider';
import type { CaptchaActionConfig } from '@/lib/captcha';
import { registerAction, sendRegisterCodeAction } from '@/lib/actions';

/** Mirrors the kernel default for `AUTH_CODE_SEND_COOLDOWN_SECONDS`. */
const SEND_CODE_COOLDOWN_SECONDS = 60;

/**
 * 服务端判定的「这枚码已经不可用」。命中就要立刻解锁重发按钮——文案说着
 * 「请重新获取」而按钮还在倒计时，是访客无法自行解除的矛盾。
 */
const DEAD_CODE_ERRORS = new Set([
  'auth.code_expired',
  'auth.code_missing',
  'auth.code_invalid',
  'auth.code_locked',
]);

/** 人机验证 token 被拒：控件必须重挂，否则会一直显示「已验证」。 */
const CAPTCHA_ERRORS = new Set(['auth.captcha_required', 'auth.captcha_failed']);

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
   * 注册动作判定「这枚码不可再用」的那一刻，之前那次「已发送」就不再是可执行的
   * 指令了。这里记住是哪一次结果吊销的它，重发成功时再清空。
   */
  const [deadCode, setDeadCode] = useState<unknown>(null);
  /**
   * Client-side echo of the kernel's per-recipient cooldown
   * (`AUTH_CODE_SEND_COOLDOWN_SECONDS`, 60s by default). The server is the
   * authority; this only stops the visitor from discovering the limit by
   * hammering the button — and shows how long the wait is.
   */
  const cooldownSignal = useMemo(
    () =>
      // 注册动作说出「这枚码已作废」时，之前那条"已发送"的 notice 就过期了：
      // 两边都参与优先级比较会打架（谁更「新」只有渲染才知道），所以由状态机
      // 自己维护——作废即吊销 notice，重发成功即解除吊销。
      deadCode
        ? { seconds: 0, rev: deadCode }
        : cooldownSignalFor([codeState], DEAD_CODE_ERRORS, SEND_CODE_COOLDOWN_SECONDS),
    [codeState, deadCode],
  );
  const cooldown = useCooldown(cooldownSignal);
  /** Client-side refusal for the send-code button (empty email, unsolved widget). */
  const [sendCodeError, setSendCodeError] = useState<string | null>(null);
  /** Client-side refusal for the sign-up button (unsolved widget). */
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  /**
   * Bumped to force a widget to re-mount. A solved token is single-use and bound
   * to one action, so after the kernel rejects it (`captcha_failed`) the visitor
   * must get a *fresh* widget — reusing a dead one leaves the form permanently
   * unsolvable with no visible cause.
   */
  const [sendCodeCaptchaReset, setSendCodeCaptchaReset] = useState(0);
  const [captchaReset, setCaptchaReset] = useState(0);
  /**
   * Set once a code has been delivered but the sign-up widget is still unsolved:
   * the second checkbox sits further down the page and is easy to miss, which
   * reads as "the form does nothing".
   */
  const [needsRegisterCaptcha, setNeedsRegisterCaptcha] = useState(false);
  const registerCaptchaRef = useRef<HTMLDivElement | null>(null);
  /**
   * Controlled values for everything the visitor typed.
   *
   * React resets an uncontrolled form when its action returns, so the email
   * entered *before* pressing "获取验证码" was wiped — `required` then blocked the
   * submit on an invisible field and the register button appeared to do nothing.
   * A rejected sign-up wiped all four fields the same way.
   */
  /**
   * Form-level complaint for a missing field.
   *
   * The sign-up button is `formNoValidate`: the send-code widget's own checkbox
   * stays `required` after its token is spent, so native validation vetoed the
   * *sign-up* submit on a control the visitor cannot see. We therefore validate
   * the required fields ourselves and say which one is missing, next to the
   * button that refused.
   */
  const [formError, setFormError] = useState<string | null>(null);
  const [values, setValues] = useState({ email: '', code: '', password: '', confirmPassword: '' });
  const field = (name: keyof typeof values) => ({
    value: values[name],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setValues((previous) => ({ ...previous, [name]: event.target.value })),
  });

  /* eslint-disable react-hooks/set-state-in-effect -- 服务端动作结果回写界面状态，渲染期对齐在 SSR 下会死循环（见 use-cooldown.ts） */
  // A rejected human-verification token is single-use: remount so the visitor can
  // solve a new one instead of staring at a widget that looks verified.
  const handledCodeRef = useRef<unknown>(null);
  useEffect(() => {
    if (handledCodeRef.current === codeState) return;
    handledCodeRef.current = codeState;
    if (codeState.errorCode && CAPTCHA_ERRORS.has(codeState.errorCode)) {
      setSendCodeToken(null);
      setSendCodeCaptchaReset((value) => value + 1);
    }
    // 新的码已投递：上一枚「已作废」的判定随之失效，倒计时重新开始。
    if (codeState.notice) setDeadCode(null);
    // A delivered code plus an unsolved sign-up widget reads as "the form does
    // nothing": say so and bring the second checkbox into view.
    if (codeState.notice && captcha?.policy === 'required' && !captchaToken) {
      setNeedsRegisterCaptcha(true);
    }
  }, [codeState, captcha?.policy, captchaToken]);

  const handledRegisterRef = useRef<unknown>(null);
  useEffect(() => {
    if (handledRegisterRef.current === state) return;
    handledRegisterRef.current = state;
    if (state.errorCode && CAPTCHA_ERRORS.has(state.errorCode)) {
      setCaptchaToken(null);
      setCaptchaReset((value) => value + 1);
    }
    // 服务端说这枚码不可用了——文案让人「重新获取」，按钮必须当场解锁，
    // 否则访客被卡在一个自己解除不了的倒计时里。
    if (state.errorCode && DEAD_CODE_ERRORS.has(state.errorCode)) setDeadCode(state);
  }, [state]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!needsRegisterCaptcha) return;
    registerCaptchaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [needsRegisterCaptcha]);
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
    const code = (form.elements.namedItem('code') as HTMLInputElement | null)?.value ?? '';
    // Required fields are enforced here instead of by the browser (see formError).
    if (!email.trim() || !email.includes('@')) {
      event.preventDefault();
      setFormError(t(email.trim() ? 'auth.validation.emailInvalid' : 'auth.validation.emailRequired'));
      return;
    }
    if (emailVerificationRequired && !code.trim()) {
      event.preventDefault();
      setFormError(t('auth.validation.codeRequired'));
      return;
    }
    setFormError(null);
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
      <form action={action} onSubmit={handleSubmit} className="flex flex-col gap-5">
        {affid ? <input type="hidden" name="affid" value={affid} /> : null}
        {captchaToken ? <input type="hidden" name="captchaToken" value={captchaToken} /> : null}
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">{t('auth.register.email')}</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="py-2.5"
            {...field('email')}
            onChange={(event) => {
              field('email').onChange(event);
              setSendCodeError(null);
            }}
          />
        </div>
        {emailVerificationRequired ? (
          <div className="flex flex-col gap-2">
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
                {...field('code')}
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
              resetSignal={sendCodeCaptchaReset}
            />
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
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
              {...field('password')}
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
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirmPassword">{t('auth.register.confirmPassword')}</Label>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            required
            className="py-2.5"
            aria-invalid={confirmError ? true : undefined}
            {...field('confirmPassword')}
          />
        </div>
        {confirmError ? <p className="text-sm text-destructive">{confirmError}</p> : null}
        {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        <div ref={registerCaptchaRef}>
          <CaptchaField
            config={captcha?.clientConfig ?? null}
            onToken={(token) => {
              setCaptchaToken(token);
              if (token) {
                setCaptchaError(null);
                setNeedsRegisterCaptcha(false);
              }
            }}
            resetSignal={captchaReset}
          />
        </div>
        {needsRegisterCaptcha ? (
          <p className="text-sm text-muted-foreground">{t('auth.register.alsoVerify')}</p>
        ) : null}
        {captchaError ? <p className="text-sm text-destructive">{captchaError}</p> : null}
        {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
        <Button
          type="submit"
          formNoValidate
          disabled={pending}
          className="h-10 w-full text-base"
        >
          {pending ? t('auth.register.submitting') : t('auth.register.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
