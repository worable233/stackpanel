'use server';
import { ApiError, validatePassword } from '@stackpanel/sdk';
import { cookies } from 'next/headers';
import { clearSessionCookie, setSessionCookie } from './session-cookie.server';
import { redirect } from 'next/navigation';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getApiClient, getAuthedApiClient } from './api';
import { AFFILIATE_COOKIE, normalizeAffiliateCode } from './affiliate';
import { apiErrorView, apiErrorMessage } from './api-errors';
import { safeInternalPath } from './safe-path';

export interface LoginState {
  error?: string;
  /**
   * Stable kernel code behind `error`.
   *
   * Forms branch on it: an expired code has to unlock the resend button, a
   * throttled one has to start a countdown, a failed human-verification has to
   * offer a fresh widget. Matching on the localised sentence would break in
   * every non-default locale.
   */
  errorCode?: string;
  /** Seconds until retry, forwarded from the kernel's `Retry-After`. */
  retryAfterSeconds?: number;
  notice?: string;
  /** Set by the send-code action so the form can show a countdown. */
  codeSentTo?: string;
  codeExpiresInSeconds?: number;
}

/**
 * Merge a structured API failure into a form state.
 *
 * Keeps `errorCode`/`retryAfterSeconds` so the form can act on the *reason*
 * (unlock a resend, start a countdown, remount the widget) instead of only
 * printing a sentence.
 */
async function failureState(error: unknown, fallback?: string): Promise<LoginState> {
  const view = await apiErrorView(error, fallback);
  return {
    error: view.error,
    ...(view.code ? { errorCode: view.code } : {}),
    ...(typeof view.retryAfterSeconds === 'number'
      ? { retryAfterSeconds: view.retryAfterSeconds }
      : {}),
  };
}

export interface AccountMutationState {
  error?: string;
  /** Stable kernel code behind `error` (see {@link LoginState.errorCode}). */
  errorCode?: string;
  /** Seconds until retry, forwarded from the kernel's `Retry-After`. */
  retryAfterSeconds?: number;
  ok?: boolean;
}

/**
 * Pull the human-verification token out of a submitted form.
 *
 * Shared by every guarded action so the optional-vs-required decision stays in
 * one place: the kernel's policy decides, the web layer only forwards what the
 * widget produced. Absent field ⇒ no token ⇒ the kernel enforces its own policy.
 */
function captchaTokenFrom(formData: FormData): { captchaToken?: string } {
  const value = formData.get('captchaToken');
  return typeof value === 'string' && value.trim() ? { captchaToken: value.trim() } : {};
}

export async function changePasswordAction(
  _prev: AccountMutationState,
  formData: FormData,
): Promise<AccountMutationState> {
  const locale = await getLocale();
  const currentPassword = formData.get('currentPassword');
  const newPassword = formData.get('newPassword');
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return { error: translate(locale, 'account.settings.security.passwordInvalid') };
  }
  // Local pre-check with the same policy the kernel enforces: it answers in the
  // user's language instead of costing a round trip, and it cannot drift because
  // the rule set lives in the SDK.
  const policy = validatePassword(newPassword);
  if (!policy.ok) return { error: translate(locale, `error.${policy.code}`) };
  try {
    await (
      await getAuthedApiClient()
    ).changePassword(currentPassword, newPassword, {
      ...captchaTokenFrom(formData),
    });
  } catch (error) {
    return failureState(
      error,
      translate(locale, 'account.settings.security.passwordChangeFailed'),
    );
  }
  redirect('/login');
}

export async function changeEmailAction(
  _prev: AccountMutationState,
  formData: FormData,
): Promise<AccountMutationState> {
  const locale = await getLocale();
  const currentPassword = formData.get('currentPassword');
  const email = formData.get('email');
  if (typeof currentPassword !== 'string' || typeof email !== 'string' || !email.includes('@')) {
    return { error: translate(locale, 'account.settings.security.emailInvalid') };
  }
  try {
    await (
      await getAuthedApiClient()
    ).changeEmail(currentPassword, email, {
      ...captchaTokenFrom(formData),
    });
  } catch (error) {
    return failureState(
      error,
      translate(locale, 'account.settings.security.emailChangeFailed'),
    );
  }
  redirect('/login');
}

function safeNextPath(value: FormDataEntryValue | null): string | null {
  return safeInternalPath(value);
}

/**
 * Server action: authenticate against the API and route the account to its
 * requested first-party destination, or its role-appropriate workspace.
 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const locale = await getLocale();
  const email = formData.get('email');
  const password = formData.get('password');
  const nextPath = safeNextPath(formData.get('next'));
  let destination = '/account';
  if (typeof email !== 'string' || typeof password !== 'string') {
    return { error: translate(locale, 'auth.validation.emailPasswordRequired') };
  }
  try {
    const result = await getApiClient().login(email, password, {
      ...captchaTokenFrom(formData),
    });
    await setSessionCookie(result.token);
    destination = nextPath ?? (result.user.role === 'ADMIN' ? '/admin' : '/account');
  } catch (error) {
    return failureState(error, translate(locale, 'auth.error.invalidCredentials'));
  }
  redirect(destination);
}

/** End the current Web BFF session and return to the public site. */
export async function logoutAction(): Promise<void> {
  try {
    await (await getAuthedApiClient()).logout();
  } catch {
    // Ignore API failures; the local session cookie is cleared regardless.
  }
  await clearSessionCookie();
  redirect('/');
}

/** Read the referral code the visitor arrived with: cookie first, then form. */
async function readAffiliateCode(formData: FormData): Promise<string | null> {
  const fromCookie = normalizeAffiliateCode((await cookies()).get(AFFILIATE_COOKIE)?.value);
  if (fromCookie) return fromCookie;
  return normalizeAffiliateCode(formData.get('affid') as string | null);
}

/** Server action: register a new local account, then route to the workspace. */
export async function registerAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const locale = await getLocale();
  const email = formData.get('email');
  const password = formData.get('password');
  if (typeof email !== 'string' || typeof password !== 'string') {
    return { error: translate(locale, 'auth.validation.emailPasswordRequired') };
  }
  const policy = validatePassword(password, { email });
  if (!policy.ok) return { error: translate(locale, `error.${policy.code}`) };
  const code = formData.get('code');
  const captchaToken = formData.get('captchaToken');
  try {
    const affid = await readAffiliateCode(formData);
    const result = await getApiClient().register(email, password, {
      affid,
      ...(typeof code === 'string' && code.trim() ? { code: code.trim() } : {}),
      ...(typeof captchaToken === 'string' && captchaToken.trim()
        ? { captchaToken: captchaToken.trim() }
        : {}),
    });
    await setSessionCookie(result.token);
    // Attribution is now recorded server-side; the landing cookie has no
    // further purpose, and keeping it would mis-attribute a second signup
    // from the same browser.
    (await cookies()).delete(AFFILIATE_COOKIE);
    redirect(result.user.role === 'ADMIN' ? '/admin' : '/account');
  } catch (error) {
    return failureState(error, translate(locale, 'auth.error.registerFailed'));
  }
}

/** Server action: request a registration email verification code. */
export async function sendRegisterCodeAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const locale = await getLocale();
  const email = formData.get('email');
  // The code request has its own guarded action, so it carries its own token;
  // fall back to the sign-up field for forms that still render a single widget.
  const captchaToken = formData.get('sendCodeCaptchaToken') ?? formData.get('captchaToken');
  if (typeof email !== 'string' || !email.trim()) {
    return { error: translate(locale, 'auth.validation.emailRequired') };
  }
  try {
    const result = await getApiClient().sendRegisterCode(email.trim(), {
      ...(typeof captchaToken === 'string' && captchaToken.trim()
        ? { captchaToken: captchaToken.trim() }
        : {}),
    });
    return {
      notice: translate(locale, 'auth.register.codeSent'),
      codeSentTo: result.email,
      codeExpiresInSeconds: result.expiresInSeconds,
    };
  } catch (error) {
    return failureState(error, translate(locale, 'auth.error.sendCodeFailed'));
  }
}

/** Server action: request a self-service password reset code. */
export async function requestPasswordResetAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const locale = await getLocale();
  const email = formData.get('email');
  const captchaToken = formData.get('captchaToken');
  if (typeof email !== 'string' || !email.trim()) {
    return { error: translate(locale, 'auth.validation.emailRequired') };
  }
  try {
    await getApiClient().requestPasswordReset(email.trim(), {
      ...(typeof captchaToken === 'string' && captchaToken.trim()
        ? { captchaToken: captchaToken.trim() }
        : {}),
    });
    return { notice: translate(locale, 'auth.reset.codeSent'), codeSentTo: email.trim() };
  } catch (error) {
    return failureState(error, translate(locale, 'auth.error.sendCodeFailed'));
  }
}

/**
 * Server action: consume the emailed code and set a new password.
 *
 * A successful reset revokes every session of the account, so the visitor is sent
 * to the sign-in page: a reset is proof of mailbox control, not a login.
 */
export async function resetPasswordAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const locale = await getLocale();
  const email = formData.get('email');
  const code = formData.get('code');
  const password = formData.get('password');
  const confirmPassword = formData.get('confirmPassword');
  if (typeof email !== 'string' || !email.trim()) {
    return { error: translate(locale, 'auth.validation.emailRequired') };
  }
  if (typeof code !== 'string' || !code.trim()) {
    return { error: translate(locale, 'auth.validation.codeRequired') };
  }
  if (typeof password !== 'string' || !password) {
    return { error: translate(locale, 'auth.validation.passwordRequired') };
  }
  if (password !== confirmPassword) {
    return { error: translate(locale, 'auth.validation.passwordMismatch') };
  }
  const policy = validatePassword(password, { email });
  if (!policy.ok) return { error: translate(locale, `error.${policy.code}`) };
  try {
    await getApiClient().resetPassword(email.trim(), code.trim(), password);
  } catch (error) {
    return failureState(error, translate(locale, 'auth.error.passwordResetFailed'));
  }
  redirect('/login?reset=1');
}

/**
 * Server action: submit infrastructure settings during first boot
 * (BOOTSTRAP-R1/R8).
 *
 * Returns a structured result instead of redirecting: the API answers 202 as
 * soon as the candidate is queued, and the page then polls
 * `GET /setup/status` for the phase. Only stable error codes and a sanitized
 * failure class ever reach the browser — never a connection string.
 */
export async function submitBootstrapAction(input: {
  setupToken: string;
  idempotencyKey: string;
  config: Record<string, string>;
}): Promise<{ ok: true } | { ok: false; error: string; failure?: string }> {
  try {
    await getApiClient().submitBootstrap(input);
    return { ok: true };
  } catch (error) {
    if (error instanceof ApiError) {
      const code = error.code ?? '';
      // 传输层失败没有业务错误码：把它和"服务端明确拒绝"分开，否则界面会
      // 提示用户去改配置，而实际原因是 API 没起来。
      if (error.status === 0 || code === 'network' || code === 'timeout') {
        return { ok: false, error: 'auth.setup.provision.errorUnreachable' };
      }
      if (code === 'bootstrap.token_invalid') {
        return { ok: false, error: 'auth.setup.provision.errorTokenInvalid' };
      }
      if (code === 'bootstrap.not_writable') {
        return { ok: false, error: 'auth.setup.provision.errorNotWritable' };
      }
      if (code === 'bootstrap.idempotency_conflict') {
        return { ok: false, error: 'auth.setup.provision.errorConflict' };
      }
      if (code === 'bootstrap.probe_failed') {
        const failure = readFailure(error.details);
        return {
          ok: false,
          error: 'auth.setup.provision.errorProbe',
          ...(failure ? { failure } : {}),
        };
      }
      if (code === 'bootstrap.invalid_config') {
        return { ok: false, error: 'auth.setup.provision.errorInvalidConfig' };
      }
      return { ok: false, error: 'auth.setup.provision.errorGeneric' };
    }
    return { ok: false, error: 'auth.setup.provision.errorUnreachable' };
  }
}

/**
 * Extract the sanitized failure class from an API error body.
 *
 * Only the classification is read; raw driver messages are never surfaced, so
 * a database password cannot leak through an error banner.
 */
function readFailure(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const failure = (body as Record<string, unknown>)['failure'];
  return typeof failure === 'string' ? failure : undefined;
}

/**
 * Server action: claim an uninitialized instance from the setup wizard. Creates
 * the first administrator, signs it in with a fresh session cookie, and routes
 * to the admin workspace. The API enforces the single-use claim under an
 * advisory lock; this action only carries the operator's input.
 */
export async function setupAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const locale = await getLocale();
  const email = formData.get('email');
  const password = formData.get('password');
  const setupToken = formData.get('setupToken');
  if (typeof email !== 'string' || typeof password !== 'string') {
    return { error: translate(locale, 'auth.validation.emailPasswordRequired') };
  }
  const policy = validatePassword(password, { email });
  if (!policy.ok) return { error: translate(locale, `error.${policy.code}`) };
  try {
    const result = await getApiClient().completeSetup({
      email: email.trim(),
      password,
      ...(typeof setupToken === 'string' && setupToken.trim()
        ? { setupToken: setupToken.trim() }
        : {}),
    });
    await setSessionCookie(result.token);
  } catch (error) {
    if (
      error instanceof ApiError &&
      ['setup.already_completed', 'setup.disabled'].includes(error.code ?? '')
    ) {
      redirect('/login');
    }
    // The API may have committed the first-admin transaction even if its
    // response was lost while the web process or connection was restarting.
    // Re-check the authoritative state before showing a misleading network
    // error on a setup form that can no longer be submitted.
    if (error instanceof ApiError && error.status === 0) {
      const setup = await getApiClient()
        .getSetupStatus()
        .catch(() => null);
      if (setup && !setup.required) redirect('/login');
    }
    return { error: await apiErrorMessage(error, translate(locale, 'auth.error.setupFailed')) };
  }
  redirect('/admin');
}
