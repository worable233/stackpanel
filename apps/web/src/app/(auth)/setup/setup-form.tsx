'use client';

import { useActionState, useEffect, useRef, useState, type FormEvent } from 'react';
import { Eye, EyeOff, Layers, LoaderCircle } from 'lucide-react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Field, FieldDescription, FieldError, FieldGroup } from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { localeOptions } from '@/i18n/core';
import { useLocale, useTranslator } from '@/i18n/provider';
import { setupAction } from '@/lib/actions';

export function SetupForm({
  platformName,
  logoSrc,
  tokenRequired,
}: {
  platformName: string;
  logoSrc?: string | null;
  tokenRequired: boolean;
}) {
  const t = useTranslator();
  const locale = useLocale();
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [token, setToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [dismissError, setDismissError] = useState(false);
  const [state, action, pending] = useActionState(setupAction, {});
  const heading = useRef<HTMLHeadingElement>(null);
  const initial = useRef(true);
  useEffect(() => {
    if (initial.current) {
      initial.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  function submit(event: FormEvent<HTMLFormElement>) {
    if (step === 1) {
      event.preventDefault();
      if (password !== confirmation) {
        setMismatch(true);
        document.getElementById('confirmation')?.focus();
        return;
      }
      setMismatch(false);
      setDismissError(true);
      setStep(2);
    } else {
      setDismissError(false);
    }
  }

  return (
    <div className="relative isolate flex min-h-svh w-full flex-col overflow-x-clip">
      <header className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-7 sm:px-10">
        <div className="inline-flex min-w-0 items-center gap-2.5 font-medium tracking-tight">
          {logoSrc ? (
            // The logo is a same-origin authenticated BFF asset, matching the existing auth shell.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoSrc} alt="" className="size-7 object-contain" />
          ) : (
            <Layers className="size-7 text-primary" aria-hidden />
          )}
          <span className="truncate">{platformName}</span>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-sm flex-1 items-center px-6 py-12 sm:px-0 sm:py-20">
        <section className="w-full" aria-labelledby="setup-heading">
          <h1
            id="setup-heading"
            ref={heading}
            tabIndex={-1}
            className="mb-8 text-2xl font-medium tracking-tight outline-none"
          >
            {t(step === 1 ? 'auth.setup.wizard.accountTitle' : 'auth.setup.wizard.confirmTitle')}
          </h1>
          <form
            action={action}
            onSubmit={submit}
            className="flex flex-col gap-7"
            aria-busy={pending}
          >
            <div
              key={step}
              className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 motion-safe:duration-300"
            >
              {step === 1 ? (
                <FieldGroup>
                  <Field>
                    <Label htmlFor="email">{t('auth.setup.email')}</Label>
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                      maxLength={254}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      className="h-10"
                      placeholder="admin@example.com"
                    />
                  </Field>
                  <Field>
                    <Label htmlFor="password">{t('auth.setup.password')}</Label>
                    <InputGroup className="h-10">
                      <InputGroupInput
                        id="password"
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        required
                        minLength={PASSWORD_MIN_LENGTH}
                        maxLength={PASSWORD_MAX_LENGTH}
                        value={password}
                        onChange={(event) => {
                          setPassword(event.target.value);
                          setMismatch(false);
                        }}
                        aria-describedby="password-hint"
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          size="icon-sm"
                          onClick={() => setShowPassword(!showPassword)}
                          aria-label={t(
                            showPassword ? 'auth.setup.hidePassword' : 'auth.setup.showPassword',
                          )}
                          aria-pressed={showPassword}
                        >
                          {showPassword ? <EyeOff /> : <Eye />}
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                    <FieldDescription id="password-hint">
                      {t('auth.setup.passwordHint', { min: PASSWORD_MIN_LENGTH })}
                    </FieldDescription>
                  </Field>
                  <Field data-invalid={mismatch}>
                    <Label htmlFor="confirmation">{t('auth.setup.wizard.confirmPassword')}</Label>
                    <InputGroup className="h-10">
                      <InputGroupInput
                        id="confirmation"
                        type={showConfirmation ? 'text' : 'password'}
                        autoComplete="new-password"
                        required
                        minLength={PASSWORD_MIN_LENGTH}
                        maxLength={PASSWORD_MAX_LENGTH}
                        value={confirmation}
                        onChange={(event) => {
                          setConfirmation(event.target.value);
                          setMismatch(false);
                        }}
                        aria-invalid={mismatch}
                        aria-describedby={mismatch ? 'confirmation-error' : undefined}
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          size="icon-sm"
                          onClick={() => setShowConfirmation(!showConfirmation)}
                          aria-label={t(
                            showConfirmation
                              ? 'auth.setup.wizard.hideConfirmation'
                              : 'auth.setup.wizard.showConfirmation',
                          )}
                          aria-pressed={showConfirmation}
                        >
                          {showConfirmation ? <EyeOff /> : <Eye />}
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                    {mismatch && (
                      <FieldError id="confirmation-error">
                        {t('auth.setup.wizard.passwordMismatch')}
                      </FieldError>
                    )}
                  </Field>
                </FieldGroup>
              ) : (
                <FieldGroup>
                  <input type="hidden" name="email" value={email.trim()} />
                  <input type="hidden" name="password" value={password} />
                  <dl className="flex flex-col gap-5 py-1 text-sm">
                    <div className="flex flex-wrap justify-between gap-2">
                      <dt className="text-muted-foreground">{t('auth.setup.email')}</dt>
                      <dd className="break-all font-medium">{email.trim()}</dd>
                    </div>
                  </dl>
                  {tokenRequired && (
                    <Field>
                      <Label htmlFor="setupToken">{t('auth.setup.token')}</Label>
                      <Input
                        id="setupToken"
                        name="setupToken"
                        type="password"
                        autoComplete="off"
                        disabled={pending}
                        required
                        value={token}
                        onChange={(event) => {
                          setToken(event.target.value);
                          setDismissError(true);
                        }}
                        className="h-10"
                      />
                      <FieldDescription>{t('auth.setup.tokenHint')}</FieldDescription>
                    </Field>
                  )}
                  {!dismissError && state.error && <FieldError>{state.error}</FieldError>}
                </FieldGroup>
              )}
            </div>
            <div className="flex items-center gap-3">
              {step === 2 && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setDismissError(true);
                    setStep(1);
                  }}
                >
                  {t('auth.setup.wizard.back')}
                </Button>
              )}
              <Button type="submit" className="h-10 flex-1" disabled={pending}>
                {pending ? (
                  <LoaderCircle className="animate-spin" data-icon="inline-start" />
                ) : null}
                {t(
                  pending
                    ? 'auth.setup.submitting'
                    : step === 1
                      ? 'auth.setup.wizard.continue'
                      : 'auth.setup.wizard.initialize',
                )}
              </Button>
            </div>
          </form>
        </section>
      </div>
      <footer className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-end gap-4 px-6 pb-6 pt-3 sm:px-10">
        <LocaleSwitcher
          locale={locale}
          items={localeOptions()}
          ariaLabel={t('localeSwitcher.ariaLabel')}
        />
      </footer>
    </div>
  );
}
