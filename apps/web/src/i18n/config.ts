import zhCN from './messages/zh-CN.json';
import enUS from './messages/en-US.json';

/**
 * All interface locales the kernel ships with.
 *
 * ADR-0016: no locale-prefixed URLs. The locale is negotiated from a cookie and
 * `Accept-Language` and applied in place; an international site is a separate
 * deployment. Adding a locale is a two-file change: drop a `<locale>.json` next
 * to the existing catalogs and register it here.
 */
export const LOCALES = ['zh-CN', 'en-US'] as const;

export type Locale = (typeof LOCALES)[number];

/** Locale assumed when nothing else can be negotiated. */
export const DEFAULT_LOCALE: Locale = 'zh-CN';

/** Cookie carrying the user's explicit interface-language choice. */
export const LOCALE_COOKIE = 'sp_locale';

/** One year, in seconds. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The shipped message directories. Network/plug-in catalogs will be able to
 * merge into this map later (ADR-0016 §5); the kernel catalog is the baseline.
 */
export const CATALOGS: Record<Locale, Record<string, unknown>> = {
  'zh-CN': zhCN as Record<string, unknown>,
  'en-US': enUS as Record<string, unknown>,
};

/** True when `value` is one of the shipped locales. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Narrow an arbitrary value to a Locale, falling back to the default. */
export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
