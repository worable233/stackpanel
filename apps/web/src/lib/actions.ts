'use server';
import { ApiError } from '@stackpanel/sdk';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getApiClient, getAuthedApiClient } from './api';
import { AFFILIATE_COOKIE, normalizeAffiliateCode } from './affiliate';
import { apiErrorMessage } from './api-errors';
import { safeInternalPath } from './safe-path';

export interface LoginState {
  error?: string;
  notice?: string;
  /** Set by the send-code action so the form can show a countdown. */
  codeSentTo?: string;
  codeExpiresInSeconds?: number;
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
    const result = await getApiClient().login(email, password);
    const store = await cookies();
    store.set(process.env.SESSION_COOKIE_NAME ?? 'sp_session', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 43200),
    });
    destination = nextPath ?? (result.user.role === 'ADMIN' ? '/admin' : '/account');
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'auth.error.invalidCredentials')) };
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
  const store = await cookies();
  store.delete(process.env.SESSION_COOKIE_NAME ?? 'sp_session');
  redirect('/');
}

/** Read the referral code the visitor arrived with: cookie first, then form. */
async function readAffiliateCode(formData: FormData): Promise<string | null> {
  const fromCookie = normalizeAffiliateCode(
    (await cookies()).get(AFFILIATE_COOKIE)?.value,
  );
  if (fromCookie) return fromCookie;
  return normalizeAffiliateCode(formData.get('affid') as string | null);
}

/** Server action: register a new local account, then route to the workspace. */
export async function registerAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const locale = await getLocale();
  const email = formData.get('email');
  const password = formData.get('password');
  if (typeof email !== 'string' || typeof password !== 'string') {
    return { error: translate(locale, 'auth.validation.emailPasswordRequired') };
  }
  if (password.length < 8) {
    return { error: translate(locale, 'auth.validation.passwordMin') };
  }
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
    const store = await cookies();
    store.set(process.env.SESSION_COOKIE_NAME ?? 'sp_session', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 43200),
    });
    // Attribution is now recorded server-side; the landing cookie has no
    // further purpose, and keeping it would mis-attribute a second signup
    // from the same browser.
    store.delete(AFFILIATE_COOKIE);
    redirect(result.user.role === 'ADMIN' ? '/admin' : '/account');
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'auth.error.registerFailed')) };
  }
}

/** Server action: request a registration email verification code. */
export async function sendRegisterCodeAction(
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
    return { error: await apiErrorMessage(error, translate(locale, 'auth.error.sendCodeFailed')) };
  }
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
  if (password.length < 8) {
    return { error: translate(locale, 'auth.validation.passwordMin') };
  }
  try {
    const result = await getApiClient().completeSetup({
      email: email.trim(),
      password,
      ...(typeof setupToken === 'string' && setupToken.trim()
        ? { setupToken: setupToken.trim() }
        : {}),
    });
    const store = await cookies();
    store.set(process.env.SESSION_COOKIE_NAME ?? 'sp_session', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 43200),
    });
  } catch (error) {
    if (error instanceof ApiError && ['setup.already_completed', 'setup.disabled'].includes(error.code ?? '')) {
      redirect('/login');
    }
    return { error: await apiErrorMessage(error, translate(locale, 'auth.error.setupFailed')) };
  }
  redirect('/admin');
}
