import type { PrismaClient } from '@stackpanel/db';
import type {
  CurrencyDefinition,
  CurrencyService as CurrencyServiceContract,
} from '@stackpanel/sdk';
import {
  CURRENCY_CATALOG,
  CurrencyError,
  assertCurrency,
  findCurrency,
  formatMinorCurrency,
  normalizeCurrencyCode,
  toMinorUnits,
} from '@stackpanel/sdk';

/** Setting key holding the platform's settlement currency. */
export const SETTLEMENT_CURRENCY_KEY = 'currency.settlement';

/** The platform default when no setting exists. */
export const DEFAULT_SETTLEMENT_CURRENCY = 'CNY';

export interface CurrencyServiceOptions {
  db: PrismaClient;
}

/**
 * Kernel-owned currency catalog.
 *
 * The catalog itself is a static, audited allow-list (`CURRENCY_CATALOG`), so
 * plugin/admin input can never mint a currency code. The `currency_definitions`
 * table only carries mutable governance state — currently the `enabled` flag —
 * plus audit timestamps. Rows are seeded lazily from the catalog.
 */
export class KernelCurrencyService implements CurrencyServiceContract {
  constructor(private readonly options: CurrencyServiceOptions) {}

  /** Read persisted overrides keyed by code (missing rows fall back to defaults). */
  private async overrides(): Promise<Map<string, boolean>> {
    const rows = await this.options.db.currencyDefinition.findMany();
    return new Map(rows.map((row) => [row.code, row.enabled]));
  }

  private toDefinition(
    base: (typeof CURRENCY_CATALOG)[number],
    enabled: boolean | undefined,
  ): CurrencyDefinition {
    return {
      code: base.code,
      name: base.name,
      symbol: base.symbol,
      minorUnit: base.minorUnit,
      enabled: enabled ?? base.enabled,
    };
  }

  async list(): Promise<CurrencyDefinition[]> {
    const overrides = await this.overrides();
    return CURRENCY_CATALOG.map((base) => this.toDefinition(base, overrides.get(base.code)));
  }

  async listEnabled(): Promise<CurrencyDefinition[]> {
    return (await this.list()).filter((definition) => definition.enabled);
  }

  async get(code: string): Promise<CurrencyDefinition | null> {
    const normalized = normalizeCurrencyCode(code);
    if (!normalized) return null;
    const base = CURRENCY_CATALOG.find((candidate) => candidate.code === normalized);
    if (!base) return null;
    const overrides = await this.overrides();
    return this.toDefinition(base, overrides.get(normalized));
  }

  async requireEnabled(code: string): Promise<CurrencyDefinition> {
    const normalized = assertCurrency(code);
    const definition = await this.get(normalized);
    // `assertCurrency` validates against the static catalog; the persisted
    // enable flag is the authoritative governance state, so re-check it here.
    if (!definition) throw new CurrencyError('currency.invalid', 400, `不支持的币种：${code}`);
    if (!definition.enabled) {
      throw new CurrencyError('currency.disabled', 409, `币种 ${definition.code} 已被停用`);
    }
    return definition;
  }

  toMinor(value: number | string, code: string): number {
    return toMinorUnits(value, code);
  }

  format(amountMinor: number, code: string, locale: string): string {
    return formatMinorCurrency(amountMinor, code, locale);
  }

  /**
   * Enable/disable a catalog entry. Disabling is refused when the currency is
   * still referenced by the settlement setting, payment history or a payment
   * method's allow-list (the plan's "a referenced currency cannot be removed").
   */
  async setEnabled(code: string, enabled: boolean): Promise<CurrencyDefinition> {
    const normalized = assertCurrency(code);
    if (!enabled) {
      const settlement = await this.getSettlementCurrency();
      if (settlement === normalized) {
        throw new CurrencyError('currency.settlement_unsupported', 409, '不能停用平台结算币种');
      }
      if ((await this.referenceStatus())[normalized]) {
        throw new CurrencyError(
          'currency.referenced',
          409,
          `币种 ${normalized} 已被支付记录或支付方式引用，不能停用`,
        );
      }
    }
    const base = CURRENCY_CATALOG.find((candidate) => candidate.code === normalized);
    if (!base) throw new CurrencyError('currency.invalid', 400, `不支持的币种：${code}`);
    await this.options.db.currencyDefinition.upsert({
      where: { code: normalized },
      create: {
        code: normalized,
        name: base.name,
        symbol: base.symbol,
        minorUnit: base.minorUnit,
        enabled,
      },
      update: { enabled, name: base.name, symbol: base.symbol, minorUnit: base.minorUnit },
    });
    return this.toDefinition(base, enabled);
  }

  /** The platform settlement currency (settings-driven, never hard-coded). */
  async getSettlementCurrency(): Promise<string> {
    const row = await this.options.db.setting.findUnique({
      where: { key: SETTLEMENT_CURRENCY_KEY },
    });
    const raw = row?.value;
    const candidate = typeof raw === 'string' ? raw : null;
    return normalizeCurrencyCode(candidate) ?? DEFAULT_SETTLEMENT_CURRENCY;
  }

  /** Persist a settlement-currency change after validating the code. */
  async setSettlementCurrency(code: string, updatedBy: string | null): Promise<string> {
    const normalized = assertCurrency(code);
    const enabled = (await this.get(normalized))?.enabled ?? false;
    if (!enabled) {
      throw new CurrencyError(
        'currency.settlement_unsupported',
        409,
        `币种 ${normalized} 已被停用`,
      );
    }
    // Compatibility guard (plan §5.3): an enabled payment method that only
    // collects specific currencies must be able to collect the new settlement
    // currency, otherwise the platform would have no way to be paid in it.
    const methods = await this.options.db.paymentMethod.findMany({
      where: { enabled: true },
      select: { name: true, currencies: true },
    });
    const incompatible = methods.find(
      (method) => method.currencies.length > 0 && !method.currencies.includes(normalized),
    );
    if (incompatible) {
      throw new CurrencyError(
        'currency.payment_method_unsupported',
        409,
        `支付方式「${incompatible.name}」不支持结算币种 ${normalized}`,
      );
    }
    await this.options.db.setting.upsert({
      where: { key: SETTLEMENT_CURRENCY_KEY },
      create: { key: SETTLEMENT_CURRENCY_KEY, value: normalized, updatedBy },
      update: { value: normalized, updatedBy },
    });
    return normalized;
  }

  /**
   * Which currencies are still referenced by data that must not lose its
   * meaning. Used by the admin list so the UI can explain why disable is off.
   */
  async referenceStatus(): Promise<Record<string, boolean>> {
    const [payments, unsettled, methods] = await Promise.all([
      this.options.db.payment.findMany({ select: { currency: true }, distinct: ['currency'] }),
      this.options.db.payment.findMany({
        where: { status: { in: ['PENDING', 'REVIEW'] } },
        select: { currency: true },
        distinct: ['currency'],
      }),
      this.options.db.paymentMethod.findMany({ select: { currencies: true } }),
    ]);
    const referenced = new Set<string>();
    for (const row of payments) referenced.add(row.currency);
    for (const row of unsettled) referenced.add(row.currency);
    for (const row of methods) for (const code of row.currencies) referenced.add(code);
    return Object.fromEntries([...referenced].map((code) => [code, true]));
  }
}

/** Resolve the settlement currency for read-only paths that lack a service. */
export async function readSettlementCurrency(db: PrismaClient): Promise<string> {
  const row = await db.setting.findUnique({ where: { key: SETTLEMENT_CURRENCY_KEY } });
  const candidate = typeof row?.value === 'string' ? row.value : null;
  return normalizeCurrencyCode(candidate) ?? DEFAULT_SETTLEMENT_CURRENCY;
}

/** Convenience: catalog entry by code, defaulting to null. */
export function catalogEntry(code: unknown): CurrencyDefinition | null {
  return findCurrency(code);
}
