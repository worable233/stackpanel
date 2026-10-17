/**
 * Kernel-owned currency catalog and minor-unit precision service.
 *
 * Plan: PLAN-currency-accuracy-and-governance §4.1 / §3.2.
 *
 * Money is always stored as an integer amount in the currency's **minor unit**
 * (fen, cents, yen). The number of decimal places is a property of the
 * currency, not of the UI: JPY/KRW have 0, most others have 2, and some have 3
 * (e.g. KWD). Frontends must never assume `/100`.
 *
 * The catalog is a closed allow-list. Plugins and admins cannot invent a
 * currency code: unknown codes, aliases and lowercase input are rejected (or
 * normalized only where an explicit alias is documented, e.g. `RMB` → `CNY`).
 */

import { KernelError, brandSdkErrorClass, isSdkErrorClass } from './errors.js';

/** A supported ISO 4217 currency and its display/precision metadata. */
export interface CurrencyDefinition {
  /** ISO 4217 code, canonical uppercase. */
  code: string;
  /** Neutral display name (the UI localizes its own label). */
  name: string;
  /** Display symbol, e.g. `¥`, `$`, `€`. */
  symbol: string;
  /** Decimal places in the minor unit: 0, 2 or 3. */
  minorUnit: number;
  /** Whether the currency may be selected for new products/payments. */
  enabled: boolean;
}

/**
 * Stable, machine-readable currency error codes (ADR-0012). Mirrors the plan's
 * §5.3 list so clients can branch without parsing messages.
 */
export type CurrencyErrorCode =
  | 'currency.invalid'
  | 'currency.disabled'
  | 'currency.minor_unit_invalid'
  | 'currency.product_immutable'
  | 'currency.referenced'
  | 'currency.rate_missing'
  | 'currency.rate_expired'
  | 'currency.settlement_unsupported'
  | 'currency.payment_method_unsupported';

/** Error thrown by the currency catalog / precision helpers. */
export class CurrencyError extends KernelError {
  constructor(code: CurrencyErrorCode, status: number, message: string) {
    super(code, status, message);
    this.name = 'CurrencyError';
  }
}

brandSdkErrorClass(CurrencyError, 'CurrencyError');

/** True when `value` is a {@link CurrencyError}, even across duplicated SDK modules. */
export function isCurrencyError(value: unknown): value is CurrencyError {
  return isSdkErrorClass(value, 'CurrencyError');
}

/**
 * Built-in currency catalog. The list is deliberately small and audited: it
 * covers the currencies this platform actually sells/collects in, and admins
 * may only enable/disable entries — never add or delete them.
 *
 * `minorUnit` follows ISO 4217 and is the single source of truth for parsing,
 * formatting, rounding and FX scaling.
 */
export const CURRENCY_CATALOG: readonly CurrencyDefinition[] = Object.freeze([
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', minorUnit: 2, enabled: true },
  { code: 'USD', name: 'US Dollar', symbol: '$', minorUnit: 2, enabled: true },
  { code: 'EUR', name: 'Euro', symbol: '€', minorUnit: 2, enabled: true },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', minorUnit: 0, enabled: true },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£', minorUnit: 2, enabled: true },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$', minorUnit: 2, enabled: true },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩', minorUnit: 0, enabled: true },
  { code: 'TWD', name: 'New Taiwan Dollar', symbol: 'NT$', minorUnit: 2, enabled: true },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', minorUnit: 2, enabled: true },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', minorUnit: 2, enabled: true },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', minorUnit: 2, enabled: true },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', minorUnit: 2, enabled: true },
  { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$', minorUnit: 2, enabled: true },
  { code: 'THB', name: 'Thai Baht', symbol: '฿', minorUnit: 2, enabled: true },
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM', minorUnit: 2, enabled: true },
  { code: 'PHP', name: 'Philippine Peso', symbol: '₱', minorUnit: 2, enabled: true },
  { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp', minorUnit: 2, enabled: true },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', minorUnit: 2, enabled: true },
  { code: 'VND', name: 'Vietnamese Dong', symbol: '₫', minorUnit: 0, enabled: true },
  { code: 'RUB', name: 'Russian Ruble', symbol: '₽', minorUnit: 2, enabled: true },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', minorUnit: 2, enabled: true },
  { code: 'MXN', name: 'Mexican Peso', symbol: 'MX$', minorUnit: 2, enabled: true },
  { code: 'CLP', name: 'Chilean Peso', symbol: 'CLP$', minorUnit: 0, enabled: true },
  { code: 'ISK', name: 'Icelandic Króna', symbol: 'kr', minorUnit: 0, enabled: true },
]);

/** Documented aliases normalized during migration and legacy API reads. */
export const CURRENCY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  RMB: 'CNY',
  CNH: 'CNY',
  YEN: 'JPY',
  USDOLLAR: 'USD',
});

/** The platform's default settlement currency when no setting exists. */
export const DEFAULT_SETTLEMENT_CURRENCY = 'CNY';

/** The wallet's single supported account currency this phase. */
export const WALLET_CURRENCY = 'CNY';

const BY_CODE = new Map<string, CurrencyDefinition>(
  CURRENCY_CATALOG.map((definition) => [definition.code, definition]),
);

/**
 * Normalize a user/legacy supplied code: trim, uppercase and map documented
 * aliases. Returns `null` when the result is not a catalog code — callers must
 * treat that as `currency.invalid` and never guess.
 */
export function normalizeCurrencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  if (!trimmed) return null;
  const aliased = CURRENCY_ALIASES[trimmed] ?? trimmed;
  return BY_CODE.has(aliased) ? aliased : null;
}

/** Look up a catalog definition by code (case-insensitive, aliases resolved). */
export function findCurrency(code: unknown): CurrencyDefinition | null {
  const normalized = normalizeCurrencyCode(code);
  return normalized ? (BY_CODE.get(normalized) ?? null) : null;
}

/** All catalog definitions (stable order). */
export function listCurrencies(): CurrencyDefinition[] {
  return [...CURRENCY_CATALOG];
}

/** Minor-unit decimal places for a code; throws `currency.invalid` when unknown. */
export function minorUnitFor(code: unknown): number {
  const definition = findCurrency(code);
  if (!definition) {
    throw new CurrencyError('currency.invalid', 400, `不支持的币种：${String(code)}`);
  }
  return definition.minorUnit;
}

/**
 * Require a supported code, throwing the plan's stable error codes.
 *
 * @param enabledOnly reject disabled currencies with `currency.disabled`.
 */
export function assertCurrency(code: unknown, options: { enabledOnly?: boolean } = {}): string {
  const definition = findCurrency(code);
  if (!definition) {
    throw new CurrencyError('currency.invalid', 400, `不支持的币种：${String(code)}`);
  }
  if (options.enabledOnly && !definition.enabled) {
    throw new CurrencyError('currency.disabled', 409, `币种 ${definition.code} 已被停用`);
  }
  return definition.code;
}

/**
 * Parse a major-unit amount (e.g. `"12.34"` or `12.34`) into integer minor
 * units using the currency's precision. Rejects excess decimal places rather
 * than silently truncating (that would change the price the customer saw).
 */
export function toMinorUnits(value: number | string, code: unknown): number {
  const definition = findCurrency(code);
  if (!definition) {
    throw new CurrencyError('currency.invalid', 400, `不支持的币种：${String(code)}`);
  }
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new CurrencyError('currency.minor_unit_invalid', 400, `金额格式无效：${String(value)}`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const fractionText = match[3] ?? '';
  if (fractionText.length > definition.minorUnit) {
    throw new CurrencyError(
      'currency.minor_unit_invalid',
      400,
      `${definition.code} 最多支持 ${definition.minorUnit} 位小数`,
    );
  }
  const padded = fractionText.padEnd(definition.minorUnit, '0');
  const amount = sign * (whole * 10n ** BigInt(definition.minorUnit) + BigInt(padded || '0'));
  const result = Number(amount);
  if (!Number.isSafeInteger(result)) {
    throw new CurrencyError('currency.minor_unit_invalid', 400, '金额超出可表示范围');
  }
  return result;
}

/** Convert integer minor units back to a major-unit number (exact as a string). */
export function toMajorUnits(amountMinor: number, code: unknown): number {
  const definition = findCurrency(code);
  if (!definition) {
    throw new CurrencyError('currency.invalid', 400, `不支持的币种：${String(code)}`);
  }
  if (!Number.isSafeInteger(amountMinor)) {
    throw new CurrencyError('currency.minor_unit_invalid', 400, '金额必须是整数最小单位');
  }
  return amountMinor / 10 ** definition.minorUnit;
}

/**
 * Exact minor-unit string (no locale), e.g. `1234` CNY → `"12.34"`, JPY → `"1234"`.
 * Used by the admin form to seed an editable amount input.
 */
export function minorUnitsToPlainString(amountMinor: number, code: unknown): string {
  const definition = findCurrency(code);
  if (!definition) {
    throw new CurrencyError('currency.invalid', 400, `不支持的币种：${String(code)}`);
  }
  if (!Number.isSafeInteger(amountMinor)) {
    throw new CurrencyError('currency.minor_unit_invalid', 400, '金额必须是整数最小单位');
  }
  const negative = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(definition.minorUnit + 1, '0');
  if (definition.minorUnit === 0) return `${negative ? '-' : ''}${digits}`;
  const cut = digits.length - definition.minorUnit;
  return `${negative ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

/**
 * Format an integer minor-unit amount as a locale-aware currency string.
 *
 * This is the single formatter for kernel/plugin frontends; themes must call
 * it rather than dividing by 100 or hard-coding `CNY ? '¥' : code`.
 */
export function formatMinorCurrency(
  amountMinor: number,
  code: unknown,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string {
  const definition = findCurrency(code);
  if (!definition) {
    throw new CurrencyError('currency.invalid', 400, `不支持的币种：${String(code)}`);
  }
  const value = toMajorUnits(amountMinor, definition.code);
  // `Intl.NumberFormat` throws when `minimumFractionDigits` exceeds the
  // caller's `maximumFractionDigits`. Compact/rounded displays (dashboard
  // axes, totals) legitimately ask for fewer decimals, so clamp rather than
  // fail — the catalog precision is a default, not a hard minimum.
  const maximumFractionDigits = options?.maximumFractionDigits ?? definition.minorUnit;
  const minimumFractionDigits = Math.min(
    options?.minimumFractionDigits ?? definition.minorUnit,
    maximumFractionDigits,
  );
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: definition.code,
    ...options,
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(value);
}

/**
 * Convert an amount between two currencies' minor units at a ×1e6 rate,
 * rounding half-up with BigInt precision. Both currencies may have different
 * `minorUnit`, which the naive `amount × rate` math ignores.
 *
 * `settlement = round(amount × rate / 1e6 × 10^(toMinor - fromMinor))`
 */
export function convertMinorUnits(
  amountMinor: number,
  fromCode: unknown,
  toCode: unknown,
  rateScaled: number,
): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new CurrencyError('currency.minor_unit_invalid', 400, '金额无效');
  }
  if (!Number.isSafeInteger(rateScaled) || rateScaled <= 0) {
    throw new CurrencyError('currency.rate_missing', 409, '汇率无效');
  }
  const from = findCurrency(fromCode);
  const to = findCurrency(toCode);
  if (!from) throw new CurrencyError('currency.invalid', 400, `不支持的币种：${String(fromCode)}`);
  if (!to) throw new CurrencyError('currency.invalid', 400, `不支持的币种：${String(toCode)}`);
  const RATE_SCALE = 1_000_000n;
  const exponent = BigInt(to.minorUnit - from.minorUnit);
  const numerator = BigInt(amountMinor) * BigInt(rateScaled);
  const scaled = exponent >= 0n ? numerator * 10n ** exponent : numerator / 10n ** -exponent;
  const whole = scaled / RATE_SCALE;
  const remainder = scaled % RATE_SCALE;
  const result = Number(whole) + (remainder * 2n >= RATE_SCALE ? 1 : 0);
  if (!Number.isSafeInteger(result)) {
    throw new CurrencyError('currency.minor_unit_invalid', 400, '换算金额超出范围');
  }
  return result;
}

/** Kernel currency service exposed to plugins via `ctx.currency`. */
export interface CurrencyService {
  /** All catalog entries (enabled flag reflects admin toggles). */
  list(): Promise<CurrencyDefinition[]>;
  /** Only enabled entries, for product/payment pickers. */
  listEnabled(): Promise<CurrencyDefinition[]>;
  /** Resolve one entry, or null when the code is unknown. */
  get(code: string): Promise<CurrencyDefinition | null>;
  /** Require an enabled code; throws `currency.invalid` / `currency.disabled`. */
  requireEnabled(code: string): Promise<CurrencyDefinition>;
  /** Parse a major-unit amount using the currency's minor unit. */
  toMinor(value: number | string, code: string): number;
  /** Format an integer minor-unit amount for display. */
  format(amountMinor: number, code: string, locale: string): string;
}
