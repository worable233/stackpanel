import type { PrismaClient } from '@stackpanel/db';
import type { FxQuote, FxRate, FxService as FxServiceContract } from '@stackpanel/sdk';
import { FxError } from '@stackpanel/sdk';

/** Rate scaling: `rate` stores from→to ×1e6. */
const RATE_SCALE = 1_000_000;

export interface FxServiceOptions {
  db: PrismaClient;
}

/**
 * Kernel-owned FX service. Converts an order's native-currency total into the
 * settlement currency at a frozen rate. Rates are admin-configured
 * (`source = 'manual'`); the structure supports a future real-time feed
 * (`source = 'api'`) without changing the contract.
 *
 * Only the one-way native→settlement direction is used in practice, so there
 * is no round-trip conversion and no arbitrage surface.
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
  }): FxRate {
    return {
      id: row.id,
      fromCurrency: row.fromCurrency,
      toCurrency: row.toCurrency,
      rate: row.rate,
      source: row.source,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }

  async getRate(from: string, to: string): Promise<FxRate | null> {
    if (from === to) {
      return null;
    }
    const row = await this.options.db.fxRate.findUnique({
      where: { fromCurrency_toCurrency: { fromCurrency: from, toCurrency: to } },
    });
    return row ? this.toRate(row) : null;
  }

  async quote(from: string, to: string, amountMinor: number): Promise<FxQuote> {
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new FxError(400, '金额无效', 'fx.amount_invalid');
    }
    if (from === to) {
      return {
        fromCurrency: from,
        toCurrency: to,
        rate: null,
        amount: amountMinor,
        settlementAmount: amountMinor,
      };
    }
    const rate = await this.getRate(from, to);
    if (!rate) {
      throw new FxError(409, `未配置 ${from} → ${to} 的汇率`, 'fx.rate_missing');
    }
    // Use BigInt to avoid float precision loss when amount×rate exceeds 2^53.
    const scaled = (BigInt(amountMinor) * BigInt(rate.rate)) / BigInt(RATE_SCALE);
    const remainder = (BigInt(amountMinor) * BigInt(rate.rate)) % BigInt(RATE_SCALE);
    const settlementAmount = Number(scaled) + (remainder * 2n >= BigInt(RATE_SCALE) ? 1 : 0);
    if (settlementAmount <= 0) {
      throw new FxError(409, `换算金额无效（${from} → ${to}）`, 'fx.amount_conversion_invalid');
    }
    return {
      fromCurrency: from,
      toCurrency: to,
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
