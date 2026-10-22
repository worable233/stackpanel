import zhCN from './messages/zh-CN.json';
import zhTW from './messages/zh-TW.json';
import zhHK from './messages/zh-HK.json';
import enUS from './messages/en-US.json';

/**
 * All interface locales the kernel ships with.
 *
 * ADR-0016: no locale-prefixed URLs. The locale is negotiated from a cookie and
 * `Accept-Language` and applied in place; an international site is a separate
 * deployment. Adding a locale is a two-file change: drop a `<locale>.json` next
 * to the existing catalogs and register it here.
 */
export const LOCALES = ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'] as const;

export type Locale = (typeof LOCALES)[number];

/** Locale assumed when nothing else can be negotiated. */
export const DEFAULT_LOCALE: Locale = 'zh-CN';

/** Cookie carrying the user's explicit interface-language choice. */
export const LOCALE_COOKIE = 'sp_locale';

/** One year, in seconds. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Script/variant siblings: a requested tag that is not shipped resolves here
 * before the region/language match, so `zh-Hant`, `zh-Hant-HK` and `zh-MO` land
 * on a Traditional Chinese catalog instead of Simplified.
 *
 * Keys are lowercase BCP 47 prefixes; the first matching entry wins.
 */
export const LOCALE_ALIASES: Record<string, Locale> = {
  'zh-hant': 'zh-TW',
  'zh-hans': 'zh-CN',
};

/**
 * The shipped message directories. Network/plug-in catalogs will be able to
 * merge into this map later (ADR-0016 §5); the kernel catalog is the baseline.
 */
export const CATALOGS: Record<Locale, Record<string, unknown>> = {
  'zh-CN': zhCN as Record<string, unknown>,
  'zh-TW': zhTW as Record<string, unknown>,
  'zh-HK': zhHK as Record<string, unknown>,
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

/**
 * Resolve any BCP 47 tag the host may receive (a package prop, a legacy cookie)
 * to a shipped catalog: exact tag, then script alias, then the language base.
 * Unlike `normalizeLocale` this never discards a usable `en` or `zh-Hant`.
 */
export function resolveLocale(value: unknown): Locale {
  if (isLocale(value)) return value;
  if (typeof value !== 'string' || !value) return DEFAULT_LOCALE;
  const lower = value.toLowerCase();
  const alias = LOCALE_ALIASES[lower] ?? LOCALE_ALIASES[lower.split('-')[0] ?? ''];
  if (alias) return alias;
  const base = lower.split('-')[0];
  if (base === 'zh') {
    // Any unspecific Chinese tag keeps the site default (Simplified).
    return DEFAULT_LOCALE;
  }
  const sameBase = LOCALES.find((locale) => locale.split('-')[0] === base);
  return sameBase ?? DEFAULT_LOCALE;
}
