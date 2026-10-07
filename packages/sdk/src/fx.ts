/**
 * Kernel-owned FX (foreign exchange) service contract.
 *
 * Light-internationalization: the store prices products in any currency, but
 * payment settles in a single settlement currency (default CNY). `ctx.fx`
 * converts an order total in its native currency to the settlement currency
 * using a frozen rate snapshot, so a later rate change never affects an open
 * order.
 *
 * Upgrade path: `FxRate.source` distinguishes `manual` (admin-configured,
 * current) from `api` (real-time feed, future). The service resolves the
 * active rate by source, so swapping the data source is a zero-call change for
 * consumers.
 */

import { KernelError, brandSdkErrorClass, isSdkErrorClass } from './errors.js';

/**
 * A frozen exchange quote for an order. Rate is an integer scaled by 1e6:
 * `settlementAmount = round(nativeAmountMinor * rate / 1_000_000)`.
 */
export interface FxQuote {
  /** The order's native currency (e.g. USD). */
  fromCurrency: string;
  /** The settlement currency (e.g. CNY). */
  toCurrency: string;
  /** from→to rate, scaled ×1e6. Null when `from === to` (no conversion). */
  rate: number | null;
  /** Order total in native minor units. */
  amount: number;
  /** Order total in settlement minor units (== amount when no conversion). */
  settlementAmount: number;
}

/** A configured FX rate row. */
export interface FxRate {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  /** from→to, scaled ×1e6. */
  rate: number;
  /** 'manual' (admin) | 'api' (future real-time feed). */
  source: string;
  updatedBy: string | null;
  updatedAt: Date;
}

/** Error thrown by the kernel FX service. Carries an HTTP status + display message. */
export class FxError extends KernelError {
  constructor(status: number, message: string, code = 'fx.error') {
    super(code, status, message);
    this.name = 'FxError';
  }
}

brandSdkErrorClass(FxError, 'FxError');

/** True when `value` is an {@link FxError}, even across duplicated SDK modules. */
export function isFxError(value: unknown): value is FxError {
  return isSdkErrorClass(value, 'FxError');
}

/** Kernel FX service exposed to plugins via `ctx.fx`. */
export interface FxService {
  /** Convert `amountMinor` in `from` currency to `to` currency at the active rate. */
  quote(from: string, to: string, amountMinor: number): Promise<FxQuote>;
  /** Read a single active rate (null when not configured). */
  getRate(from: string, to: string): Promise<FxRate | null>;
  /** List all configured rates (for admin views). */
  listRates(): Promise<FxRate[]>;
}
