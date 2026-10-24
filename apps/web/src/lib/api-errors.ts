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
 * Only the stable `code` (catalog `error.<code>`) reaches the user, followed by
 * the caller's localised fallback (default `common.operationFailed`). Network
 * failures (status 0) surface a dedicated message. The server's neutral English
 * `title`/`detail` and raw exception text are **never** rendered: they leak
 * technical vocabulary (`fetch failed`, `SignatureDoesNotMatch`, …) and can
 * contain internal identifiers. They go to `console.error` for operators only.
 */
export function apiErrorMessageFor(
  locale: Locale,
  error: unknown,
  fallback?: string,
): string {
  const resolvedFallback = fallback ?? translate(locale, 'common.operationFailed');
  if (error instanceof ApiError) {
    if (error.status === 0) return translate(locale, 'common.networkError');
    const localized = lookupTranslation(locale, `error.${error.code}`);
    if (localized) return localized;
    logRawError(error);
    return resolvedFallback;
  }
  logRawError(error);
  return resolvedFallback;
}

/** Keep the diagnostic in server logs; it must not become user-facing copy. */
function logRawError(error: unknown): void {
  if (error instanceof ApiError) {
    console.error(`[api-errors] ${error.code || 'unknown'}: ${error.message}`);
    return;
  }
  if (error instanceof Error) console.error('[api-errors]', error);
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
