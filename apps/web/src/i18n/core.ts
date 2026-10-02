import { CATALOGS, DEFAULT_LOCALE, LOCALES, type Locale } from './config';

export type MessageParams = Record<string, string | number>;

/** A translator for one locale: resolve a message id and interpolate params. */
export type Translator = (key: string, params?: MessageParams) => string;

/**
 * Resolve a dotted message id against a catalog.
 *
 * Ids are stable and language-independent (ADR-0016 §2): `auth.login.title`,
 * `error.auth.invalid_credentials`. Returns `undefined` when the path is
 * missing or does not resolve to a string.
 */
export function lookupMessage(
  catalog: Record<string, unknown>,
  key: string,
): string | undefined {
  let node: unknown = catalog;
  for (const segment of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Replace `{name}` placeholders with values. Unknown placeholders are left
 * intact so a missing param is visible rather than silently blanked.
 */
export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

const warned = new Set<string>();

function warnMissing(locale: Locale, key: string): void {
  if (process.env.NODE_ENV === 'production') return;
  const token = `${locale}:${key}`;
  if (warned.has(token)) return;
  warned.add(token);
  // Development-only signal; production falls back to the key silently.
  console.warn(`[i18n] missing message "${key}" for locale "${locale}"`);
}

/** Catalogs available to translation: shipped defaults plus optional overrides. */
export type CatalogOverrides = Partial<Record<Locale, Record<string, unknown>>>;

function catalogFor(locale: Locale, overrides?: CatalogOverrides): Record<string, unknown> {
  const override = overrides?.[locale];
  if (!override) return CATALOGS[locale];
  return { ...CATALOGS[locale], ...override };
}

/**
 * Resolve a message without warning, applying the same fallback chain as
 * `translate` but returning `undefined` when the id is absent. Used where a
 * missing key is expected (e.g. API error codes the UI has not localised yet).
 */
export function lookupTranslation(
  locale: Locale,
  key: string,
  params?: MessageParams,
  overrides?: CatalogOverrides,
): string | undefined {
  const localized = lookupMessage(catalogFor(locale, overrides), key);
  if (localized !== undefined) return formatMessage(localized, params);

  if (locale !== DEFAULT_LOCALE) {
    const fallback = lookupMessage(catalogFor(DEFAULT_LOCALE, overrides), key);
    if (fallback !== undefined) return formatMessage(fallback, params);
  }
  return undefined;
}

/**
 * Translate a message id for `locale`.
 *
 * Fallback chain (ADR-0016 §2): requested locale -> site default locale -> the
 * key itself, so a missing message is obvious in the UI and in dev logs.
 */
export function translate(
  locale: Locale,
  key: string,
  params?: MessageParams,
  overrides?: CatalogOverrides,
): string {
  const message = lookupTranslation(locale, key, params, overrides);
  if (message !== undefined) return message;
  warnMissing(locale, key);
  return key;
}

/** Bind a locale (and optional catalog overrides) into a `Translator`. */
export function createTranslator(locale: Locale, overrides?: CatalogOverrides): Translator {
  return (key, params) => translate(locale, key, params, overrides);
}

/** `value`/`label` pairs for a language picker, labelled by endonym. */
export function localeOptions(): { value: Locale; label: string }[] {
  return LOCALES.map((locale) => ({
    value: locale,
    label: translate(DEFAULT_LOCALE, `locale.${locale}`),
  }));
}

// --- Locale-aware formatting (ADR-0016 §6) ---

/** Format a number using `Intl.NumberFormat` for the site locale. */
export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/** Format a date/time using `Intl.DateTimeFormat` for the site locale. */
export function formatDate(
  value: Date | number,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}

/**
 * Format a currency amount. The settlement currency is independent of the
 * interface locale (ADR-0016 §6); only the presentation follows `locale`.
 */
export function formatCurrency(
  value: number,
  currency: string,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, ...options }).format(value);
}

/**
 * Number of minor units per major unit for a currency. Only the zero-decimal
 * currencies the platform actually settles in are special-cased; everything
 * else follows the ISO 4217 default of 2.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);

/**
 * Format a minor-unit amount (fen/cents) as locale-aware currency. The platform
 * stores money in minor units; `currency` selects the symbol and the divisor,
 * while `locale` drives grouping/decimal presentation (ADR-0016 §6).
 */
export function formatMoney(
  amountMinor: number,
  currency: string,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  const divisor = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
  return formatCurrency(amountMinor / divisor, currency, locale, options);
}
