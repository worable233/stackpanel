import type { PrismaClient } from '@stackpanel/db';
import type { FxQuote, FxRate, FxService as FxServiceContract } from '@stackpanel/sdk';
import {
  CurrencyError,
  FxError,
  assertCurrency,
  convertMinorUnits,
  findCurrency,
  normalizeCurrencyCode,
} from '@stackpanel/sdk';
import { DEFAULT_SETTLEMENT_CURRENCY, SETTLEMENT_CURRENCY_KEY } from '../currency/service.ts';

/** Rate scaling: `rate` stores from→to ×1e6. */
const RATE_SCALE = 1_000_000;

export interface FxServiceOptions {
  db: PrismaClient;
  /**
   * Resolve the platform settlement currency. Defaults to reading the
   * `currency.settlement` setting so the service works without the full
   * currency service (unit tests, worker boot).
   */
  getSettlementCurrency?: () => Promise<string>;
}

/**
 * Kernel-owned FX service. Converts an order's native-currency total into the
 * platform settlement currency at a frozen rate. Rates are admin-configured
 * (`source = 'manual'`); the structure supports a future real-time feed
 * (`source = 'api'`) without changing the contract.
 *
 * Only the one-way native→settlement direction is used in practice, so there
 * is no round-trip conversion and no arbitrage surface. Both currencies'
 * `minorUnit` are honoured, so USD→JPY does not silently gain two decimals.
 */
export class FxService implements FxServiceContract {
  constructor(private readonly options: FxServiceOptions) {}

  private toRate(row: {
    id: string;
    fromCurrency: string;
    toCurrency: string;
    rate: number;
    source: string;
    updatedBy: string | null;
    updatedAt: Date;
    validUntil?: Date | null;
  }): FxRate {
    return {
      id: row.id,
      fromCurrency: row.fromCurrency,
      toCurrency: row.toCurrency,
      rate: row.rate,
      source: row.source,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
      validUntil: row.validUntil ?? null,
    };
  }

  async getRate(from: string, to: string): Promise<FxRate | null> {
    const fromCode = normalizeCurrencyCode(from);
    const toCode = normalizeCurrencyCode(to);
    if (!fromCode || !toCode) return null;
    if (fromCode === toCode) {
      return null;
    }
    const row = await this.options.db.fxRate.findUnique({
      where: { fromCurrency_toCurrency: { fromCurrency: fromCode, toCurrency: toCode } },
    });
    return row ? this.toRate(row) : null;
  }

  async getSettlementCurrency(): Promise<string> {
    if (this.options.getSettlementCurrency) return this.options.getSettlementCurrency();
    const row = await this.options.db.setting.findUnique({
      where: { key: SETTLEMENT_CURRENCY_KEY },
    });
    const candidate = typeof row?.value === 'string' ? row.value : null;
    return normalizeCurrencyCode(candidate) ?? DEFAULT_SETTLEMENT_CURRENCY;
  }

  async quoteToSettlement(from: string, amountMinor: number): Promise<FxQuote> {
    const settlement = await this.getSettlementCurrency();
    return this.quote(from, settlement, amountMinor);
  }

  async quote(from: string, to: string, amountMinor: number): Promise<FxQuote> {
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new FxError(400, '金额无效', 'fx.amount_invalid');
    }
    // Both ends must be catalog currencies. Unknown codes never reach a rate
    // lookup, so a typo can't silently settle at a fabricated rate.
    const fromCode = assertCurrency(from);
    const toCode = assertCurrency(to);

    if (fromCode === toCode) {
      return {
        fromCurrency: fromCode,
        toCurrency: toCode,
        rate: null,
        amount: amountMinor,
        settlementAmount: amountMinor,
      };
    }
    const rate = await this.getRate(fromCode, toCode);
    if (!rate) {
      throw new CurrencyError(
        'currency.rate_missing',
        409,
        `未配置 ${fromCode} → ${toCode} 的汇率`,
      );
    }
    if (rate.validUntil && rate.validUntil.getTime() < Date.now()) {
      throw new CurrencyError(
        'currency.rate_expired',
        409,
        `${fromCode} → ${toCode} 的汇率已于 ${rate.validUntil.toISOString()} 过期`,
      );
    }
    if (!findCurrency(fromCode) || !findCurrency(toCode)) {
      throw new CurrencyError('currency.invalid', 400, '不支持的币种');
    }
    const settlementAmount = convertMinorUnits(amountMinor, fromCode, toCode, rate.rate);
    if (settlementAmount <= 0) {
      throw new CurrencyError(
        'currency.rate_missing',
        409,
        `换算金额无效（${fromCode} → ${toCode}）`,
      );
    }
    return {
      fromCurrency: fromCode,
      toCurrency: toCode,
      rate: rate.rate,
      amount: amountMinor,
      settlementAmount,
    };
  }

  async listRates(): Promise<FxRate[]> {
    const rows = await this.options.db.fxRate.findMany({ orderBy: { fromCurrency: 'asc' } });
    return rows.map((row) => this.toRate(row));
  }
}

export { RATE_SCALE };
