import {
  formatMinorCurrency,
  minorUnitFor,
  minorUnitsToPlainString,
  toMinorUnits,
} from '@stackpanel/sdk';
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
 * Format a date and/or time. Alias of `formatDate` with an intent-revealing
 * name for call sites that render a timestamp rather than a calendar day.
 * Pass `timeZone` explicitly when the value must not follow the host clock.
 */
export function formatDateTime(
  value: Date | number,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
): string {
  return formatDate(value, locale, options);
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
 * Format a minor-unit amount (fen/cents) as locale-aware currency. The platform
 * stores money in minor units; the divisor comes from the **kernel currency
 * catalog** (`minorUnit`), never from a local `CNY`/`JPY` special case, so a
 * newly enabled currency renders correctly without a code change.
 *
 * This is the single formatter for web/admin/theme money display.
 */
export function formatMoney(
  amountMinor: number,
  currency: string,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  try {
    return formatMinorCurrency(amountMinor, currency, locale, options);
  } catch {
    // Historical rows may carry a currency that was removed from the catalog.
    // Never crash a list view over it; show the code with the raw amount.
    return `${amountMinor} ${currency}`;
  }
}

/**
 * Minor-unit decimal places for a currency, from the kernel catalog. Returns 2
 * for unknown codes so a legacy row still renders something sane.
 */
export function currencyMinorUnit(currency: string): number {
  try {
    return minorUnitFor(currency);
  } catch {
    return 2;
  }
}

/**
 * Parse a user-entered major-unit amount ("12.34") into integer minor units
 * using the currency's precision. Returns `null` when the input is not a valid
 * amount for that currency (too many decimals, non-numeric, unsafe range).
 */
export function parseAmountToMinor(value: string, currency: string): number | null {
  try {
    return toMinorUnits(value, currency);
  } catch {
    return null;
  }
}

/** Exact editable string for a minor-unit amount ("12.34", or "1234" for JPY). */
export function formatMinorForInput(amountMinor: number, currency: string): string {
  try {
    return minorUnitsToPlainString(amountMinor, currency);
  } catch {
    return String(amountMinor / 100);
  }
}

/** Format a ratio (0.42) as a locale-aware percentage ("42%"). */
export function formatPercent(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, { style: 'percent', ...options }).format(value);
}

/** Format a value with a measurement unit ("1.5 MB", "3 公里"). */
export function formatUnit(
  value: number,
  unit: Intl.NumberFormatOptions['unit'],
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, { style: 'unit', unit, ...options }).format(value);
}

/**
 * Units for `formatFileSize`, largest first. Binary (1024) scaling, matching
 * what users see in OS file managers; `Intl` renders the unit name per locale.
 */
const FILE_SIZE_UNITS: { unit: Intl.NumberFormatOptions['unit']; limit: number }[] = [
  { unit: 'terabyte', limit: 1024 ** 4 },
  { unit: 'gigabyte', limit: 1024 ** 3 },
  { unit: 'megabyte', limit: 1024 ** 2 },
  { unit: 'kilobyte', limit: 1024 },
];

/**
 * Format a byte count as a human-readable file size in the site locale
 * ("1.5 MB" / "1.5 兆字节"). Uses binary steps and picks the largest unit that
 * keeps the number >= 1, falling back to bytes.
 */
export function formatFileSize(
  bytes: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  const magnitude = Math.abs(bytes);
  const step = FILE_SIZE_UNITS.find((entry) => magnitude >= entry.limit);
  if (!step) {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'byte',
      unitDisplay: 'narrow',
      ...options,
    }).format(bytes);
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: step.unit,
    unitDisplay: 'short',
    maximumFractionDigits: 1,
    ...options,
  }).format(bytes / step.limit);
}

/**
 * Format a relative time from `value` to `now` using `Intl.RelativeTimeFormat`
 * ("3 小时前" / "in 3 hours"). Chooses the largest unit that keeps the value
 * >= 1; pass a fixed `now` in tests to keep output deterministic.
 */
export function formatRelativeTime(
  value: Date | number,
  locale: Locale,
  options?: Intl.RelativeTimeFormatOptions & { now?: Date | number },
): string {
  const { now, ...formatOptions } = options ?? {};
  const target = value instanceof Date ? value.getTime() : value;
  const reference = now === undefined ? Date.now() : now instanceof Date ? now.getTime() : now;
  const deltaSeconds = Math.round((target - reference) / 1000);
  const units: { unit: Intl.RelativeTimeFormatUnit; seconds: number }[] = [
    { unit: 'year', seconds: 60 * 60 * 24 * 365 },
    { unit: 'month', seconds: 60 * 60 * 24 * 30 },
    { unit: 'week', seconds: 60 * 60 * 24 * 7 },
    { unit: 'day', seconds: 60 * 60 * 24 },
    { unit: 'hour', seconds: 60 * 60 },
    { unit: 'minute', seconds: 60 },
    { unit: 'second', seconds: 1 },
  ];
  const chosen =
    units.find((entry) => Math.abs(deltaSeconds) >= entry.seconds) ?? units[units.length - 1];
  return new Intl.RelativeTimeFormat(locale, formatOptions).format(
    Math.round(deltaSeconds / chosen.seconds),
    chosen.unit,
  );
}

/** Join a list with locale-aware separators ("a, b, and c"). */
export function formatList(
  items: readonly string[],
  locale: Locale,
  options?: Intl.ListFormatOptions,
): string {
  return new Intl.ListFormat(locale, options).format(items);
}

/**
 * Pick a message variant by plural category.
 *
 * `variants` is keyed by CLDR plural category (`one`/`other`/...); the caller
 * keeps the copy in the catalog, this only selects the right branch for the
 * locale's rules. `other` is required by CLDR and used as the last resort.
 */
export function formatPlural(
  count: number,
  locale: Locale,
  variants: Record<Intl.LDMLPluralRule, string>,
  options?: Intl.PluralRulesOptions,
): string {
  const category = new Intl.PluralRules(locale, options).select(count);
  return variants[category] ?? variants.other;
}
