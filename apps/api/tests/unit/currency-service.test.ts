import { describe, expect, it } from 'vitest';
import { KernelCurrencyService, SETTLEMENT_CURRENCY_KEY } from '../../src/currency/service.ts';

interface Row {
  code: string;
  enabled: boolean;
}

function makeService(
  options: {
    overrides?: Row[];
    settlement?: string | null;
    payments?: Array<{ currency: string; status: string }>;
    methods?: Array<{ name: string; currencies: string[] }>;
  } = {},
): {
  service: KernelCurrencyService;
  writes: Array<{ code: string; enabled: boolean }>;
  settingWrites: Array<{ key: string; value: unknown }>;
} {
  const writes: Array<{ code: string; enabled: boolean }> = [];
  const settingWrites: Array<{ key: string; value: unknown }> = [];
  const overrides = new Map((options.overrides ?? []).map((row) => [row.code, row.enabled]));
  const payments = options.payments ?? [];

  const db = {
    currencyDefinition: {
      findMany: async () =>
        [...overrides].map(([code, enabled]) => ({
          code,
          enabled,
          name: code,
          symbol: code,
          minorUnit: 2,
        })),
      upsert: async (input: {
        where: { code: string };
        create: { code: string; enabled: boolean };
        update: { enabled: boolean };
      }) => {
        const enabled = input.create.enabled ?? input.update.enabled;
        overrides.set(input.where.code, enabled);
        writes.push({ code: input.where.code, enabled });
        return { code: input.where.code, enabled };
      },
    },
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        where.key === SETTLEMENT_CURRENCY_KEY &&
        options.settlement !== undefined &&
        options.settlement !== null
          ? { key: where.key, value: options.settlement }
          : null,
      upsert: async (input: { where: { key: string }; create: { value: unknown } }) => {
        settingWrites.push({ key: input.where.key, value: input.create.value });
        return input;
      },
    },
    payment: {
      findMany: async ({ where }: { where?: { status?: { in?: string[] } } } = {}) =>
        where?.status?.in
          ? payments.filter((payment) => where.status?.in?.includes(payment.status))
          : payments,
    },
    paymentMethod: {
      findMany: async () => options.methods ?? [],
    },
  };

  return {
    service: new KernelCurrencyService({ db: db as never }),
    writes,
    settingWrites,
  };
}

describe('KernelCurrencyService', () => {
  it('lists the static catalog when no overrides exist', async () => {
    const { service } = makeService();
    const definitions = await service.list();
    expect(definitions.length).toBeGreaterThan(10);
    expect(definitions.find((definition) => definition.code === 'CNY')).toMatchObject({
      minorUnit: 2,
      enabled: true,
    });
    expect(definitions.find((definition) => definition.code === 'JPY')).toMatchObject({
      minorUnit: 0,
      enabled: true,
    });
  });

  it('applies a persisted disable override', async () => {
    const { service } = makeService({ overrides: [{ code: 'USD', enabled: false }] });
    const usd = await service.get('usd');
    expect(usd).toMatchObject({ code: 'USD', enabled: false });
    const enabled = await service.listEnabled();
    expect(enabled.some((definition) => definition.code === 'USD')).toBe(false);
  });

  it('normalizes aliases and case on lookup', async () => {
    const { service } = makeService();
    await expect(service.get('rmb')).resolves.toMatchObject({ code: 'CNY' });
    await expect(service.get('usd')).resolves.toMatchObject({ code: 'USD' });
    await expect(service.get('BTC')).resolves.toBeNull();
  });

  it('rejects unknown codes and disabled currencies via requireEnabled', async () => {
    const { service } = makeService({ overrides: [{ code: 'JPY', enabled: false }] });
    await expect(service.requireEnabled('BTC')).rejects.toMatchObject({ code: 'currency.invalid' });
    await expect(service.requireEnabled('JPY')).rejects.toMatchObject({
      code: 'currency.disabled',
    });
    await expect(service.requireEnabled('usd')).resolves.toMatchObject({ code: 'USD' });
  });

  it('parses and formats using the catalog minor unit', () => {
    const { service } = makeService();
    expect(service.toMinor('12.34', 'CNY')).toBe(1234);
    expect(service.toMinor('1234', 'JPY')).toBe(1234);
    expect(service.format(1234, 'USD', 'en-US')).toContain('$');
  });

  it('persists enable/disable toggles', async () => {
    const { service, writes } = makeService();
    const updated = await service.setEnabled('usd', false);
    expect(updated.enabled).toBe(false);
    expect(writes.at(-1)).toEqual({ code: 'USD', enabled: false });
  });

  it('refuses to disable the settlement currency', async () => {
    const { service } = makeService({ settlement: 'CNY' });
    await expect(service.setEnabled('CNY', false)).rejects.toMatchObject({
      code: 'currency.settlement_unsupported',
    });
  });

  it('refuses to disable a currency referenced by payments or methods', async () => {
    const { service } = makeService({
      payments: [{ currency: 'USD', status: 'SUCCEEDED' }],
      methods: [{ name: 'USD only', currencies: ['USD'] }],
    });
    await expect(service.setEnabled('USD', false)).rejects.toMatchObject({
      code: 'currency.referenced',
    });
  });

  it('rejects an unknown code when toggling', async () => {
    const { service } = makeService();
    await expect(service.setEnabled('BTC', false)).rejects.toMatchObject({
      code: 'currency.invalid',
    });
  });

  it('defaults the settlement currency to CNY when unset', async () => {
    const { service } = makeService();
    await expect(service.getSettlementCurrency()).resolves.toBe('CNY');
  });

  it('reads and normalizes a persisted settlement currency', async () => {
    const { service } = makeService({ settlement: 'rmb' });
    await expect(service.getSettlementCurrency()).resolves.toBe('CNY');
  });

  it('rejects a disabled settlement currency', async () => {
    const { service } = makeService({
      settlement: 'CNY',
      overrides: [{ code: 'USD', enabled: false }],
    });
    await expect(service.setSettlementCurrency('USD', null)).rejects.toMatchObject({
      code: 'currency.settlement_unsupported',
    });
  });

  it('persists a valid settlement currency change', async () => {
    const { service, settingWrites } = makeService();
    await expect(service.setSettlementCurrency('usd', 'admin_1')).resolves.toBe('USD');
    expect(settingWrites.at(-1)).toEqual({ key: SETTLEMENT_CURRENCY_KEY, value: 'USD' });
  });

  it('refuses a settlement currency no enabled payment method can collect', async () => {
    const { service, settingWrites } = makeService({
      methods: [{ name: 'USD only', currencies: ['USD'] }],
    });
    await expect(service.setSettlementCurrency('EUR', null)).rejects.toMatchObject({
      code: 'currency.payment_method_unsupported',
    });
    expect(settingWrites).toHaveLength(0);
  });

  it('reports currencies referenced by payment history', async () => {
    const { service } = makeService({
      payments: [
        { currency: 'USD', status: 'PAID' },
        { currency: 'CNY', status: 'PENDING' },
      ],
    });
    await expect(service.referenceStatus()).resolves.toEqual({ USD: true, CNY: true });
  });
});
