'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { getApiClient, getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';

export interface LoginState {
  error?: string;
}

function safeNextPath(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
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
  try {
    const result = await getApiClient().register(email, password);
    const store = await cookies();
    store.set(process.env.SESSION_COOKIE_NAME ?? 'sp_session', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 43200),
    });
    redirect(result.user.role === 'ADMIN' ? '/admin' : '/account');
  } catch (error) {
    return { error: await apiErrorMessage(error, translate(locale, 'auth.error.registerFailed')) };
  }
}
