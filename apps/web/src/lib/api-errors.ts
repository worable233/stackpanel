import 'server-only';

import { ApiError } from '@stackpanel/sdk';
import { DEFAULT_LOCALE, type Locale } from '@/i18n/config';
import { lookupTranslation, translate } from '@/i18n/core';
import { getLocale } from '@/i18n/locale';

/**
 * UI-side rendering of API error codes (ADR-0012 §4/§6, ADR-0016 §3).
 *
 * The API never localises: it returns neutral English `title`/`detail` plus a
 * stable `code`. The UI owns the copy and looks the code up under the `error.*`
 * namespace of the active locale's message directory.
 *
 * Codes are never reused with a new meaning, so the catalog is append-mostly.
 */

/**
 * Localise an error for display using an explicit locale.
 *
 * Prefers the stable `code` (catalog `error.<code>`), then the server's neutral
 * message, then the caller's fallback. Network failures (status 0) surface a
 * dedicated message. Missing codes fall through silently — a plugin may emit a
 * code the UI has not translated yet.
 */
export function apiErrorMessageFor(
  locale: Locale,
  error: unknown,
  fallback?: string,
): string {
  const resolvedFallback = fallback ?? translate(locale, 'common.operationFailed');
  if (error instanceof ApiError) {
    if (error.status === 0) return translate(locale, 'common.networkError');
    return (
      lookupTranslation(locale, `error.${error.code}`) ??
      (error.message || resolvedFallback)
    );
  }
  if (error instanceof Error && error.message) return error.message;
  return resolvedFallback;
}

/**
 * Localise an error using the current request locale. Server components and
 * server actions call this; it reads the negotiated locale from the cookie /
 * `Accept-Language` and falls back to the default locale.
 */
export async function apiErrorMessage(error: unknown, fallback?: string): Promise<string> {
  return apiErrorMessageFor(await getLocale(), error, fallback);
}

/** Default-locale variant for callers without a request scope (tests, tooling). */
export function apiErrorMessageDefault(error: unknown, fallback?: string): string {
  return apiErrorMessageFor(DEFAULT_LOCALE, error, fallback);
}
