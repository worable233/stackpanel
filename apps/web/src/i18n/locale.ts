import 'server-only';

import { cookies, headers } from 'next/headers';
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale, type Locale } from './config';
import { negotiateLocale } from './negotiate';

/**
 * Resolve the active interface locale for the current request (ADR-0016 §1).
 *
 * Precedence: explicit `sp_locale` cookie -> `Accept-Language` negotiation ->
 * default locale. No URL prefix is ever involved, matching `localePrefix:
 * 'never'`. Any invalid cookie value is ignored.
 */
export async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const saved = cookieStore.get(LOCALE_COOKIE)?.value;
  if (saved) return normalizeLocale(saved);

  const headerStore = await headers();
  return negotiateLocale(headerStore.get('accept-language'), undefined, DEFAULT_LOCALE);
}
