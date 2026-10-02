'use server';

import { cookies } from 'next/headers';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, normalizeLocale } from './config';

/**
 * Persist the user's explicit interface-language choice (ADR-0016 §1).
 *
 * The locale is stored in a cookie and applied in place; no URL prefix is
 * written. Invalid values are coerced to the default locale. The caller is
 * expected to refresh the route so server components re-read the cookie.
 */
export async function setLocaleAction(locale: string): Promise<void> {
  const normalized = normalizeLocale(locale);
  const store = await cookies();
  store.set(LOCALE_COOKIE, normalized, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}
