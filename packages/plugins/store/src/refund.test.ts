import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CustomModelDefinition,
  ExtensionClient,
  ExtensionInstance,
  PluginContext,
} from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';
import { refundOrder } from './refund';

function createFakeExtensions() {
  const tables = new Map<string, Map<string, Stored>>();
  let seq = 0;
  type Stored = {
    name: string;
    spec: Record<string, unknown>;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  };
  const table = (kind: string): Map<string, Stored> => {
    let existing = tables.get(kind);
    if (!existing) {
      existing = new Map();
      tables.set(kind, existing);
    }
    return existing;
  };
  const fieldValue = (row: Stored, field: string): unknown => {
    if (field === 'name') return row.name;
    if (field === 'createdAt') return row.createdAt;
    if (field === 'updatedAt') return row.updatedAt;
    return row.spec[field];
  };
  const matches = (row: Stored, where: Record<string, Record<string, unknown>>): boolean => {
    for (const [field, cond] of Object.entries(where)) {
      const value = fieldValue(row, field);
      if ('eq' in cond && value !== cond.eq) return false;
      if ('in' in cond && !(cond.in as unknown[]).includes(value)) return false;
    }
    return true;
  };
  const applyPatch = (
    spec: Record<string, unknown>,
    patch: Record<string, { set?: unknown; inc?: number; dec?: number }>,
  ) => {
    for (const [key, op] of Object.entries(patch)) {
      if ('set' in op) spec[key] = op.set;
      else if ('inc' in op) spec[key] = ((spec[key] as number) ?? 0) + (op.inc as number);
      else if ('dec' in op) spec[key] = ((spec[key] as number) ?? 0) - (op.dec as number);
    }
  };
  const client = {
    async get(model: CustomModelDefinition, name: string): Promise<ExtensionInstance | null> {
      const row = table(model.kind).get(name);
      return row ? (row as unknown as ExtensionInstance) : null;
    },
    async list(
      model: CustomModelDefinition,
      query: { where?: Record<string, Record<string, unknown>> },
    ) {
      const rows = [...table(model.kind).values()].filter((row) => matches(row, query.where ?? {}));
      return {
        items: rows as unknown as ExtensionInstance[],
        total: rows.length,
        page: 1,
        pageSize: rows.length,
      };
    },
    async listAll(
      model: CustomModelDefinition,
      query: { where?: Record<string, Record<string, unknown>> },
    ) {
      return [...table(model.kind).values()].filter((row) =>
        matches(row, query?.where ?? {}),
      ) as unknown as ExtensionInstance[];
    },
    async create(model: CustomModelDefinition, spec: Record<string, unknown>) {
      const name = `${model.kind}-${++seq}`;
      const row: Stored = {
        name,
        spec: { ...spec },
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      table(model.kind).set(name, row);
      return row as unknown as ExtensionInstance;
    },
    async update(model: CustomModelDefinition, name: string, spec: Record<string, unknown>) {
      const row = table(model.kind).get(name);
      if (!row) throw new Error(`not found: ${name}`);
      row.spec = { ...spec };
      return row as unknown as ExtensionInstance;
    },
    async updateWhere(
      model: CustomModelDefinition,
      where: Record<string, Record<string, unknown>>,
      patch: Record<string, { set?: unknown; inc?: number; dec?: number }>,
    ) {
      const rows = [...table(model.kind).values()].filter((row) => matches(row, where));
      for (const row of rows) applyPatch(row.spec, patch);
      return { updated: rows.length };
    },
    async delete(model: CustomModelDefinition, name: string) {
      table(model.kind).delete(name);
    },
  };
  return {
    client: client as unknown as ExtensionClient,
    seed(kind: string, spec: Record<string, unknown>, name?: string): string {
      const key = name ?? `${kind}-${++seq}`;
      table(kind).set(key, {
        name: key,
        spec: { ...spec },
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return key;
    },
    all(kind: string): Stored[] {
      return [...table(kind).values()];
    },
  };
}

function makeCtx(
  fake: ReturnType<typeof createFakeExtensions>,
  credit: ReturnType<typeof vi.fn>,
): PluginContext {
  return {
    manifest: { id: 'store', name: '商店插件', version: '0.3.0' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    events: {
      publish: () => {},
      subscribe: () => () => {},
      intercept: () => () => {},
      waterfall: <T>(_topic: string, value: T, _terminal: (value: T) => T): T => value,
    },
    extensions: fake.client,
    tx: (async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        extensions: fake.client,
        wallet: { debit: vi.fn(), credit },
        payments: { createRecord: vi.fn() },
      })) as never,
    secrets: {
      isAvailable: () => true,
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
    payments: {} as never,
    wallet: {} as never,
    fx: {} as never,
    auth: {} as never,
    notifications: {} as never,
    state: {} as never,
    jobs: {} as never,
    cache: {} as never,
    media: {
      register: async () => {},
      unregister: async () => {},
      unregisterResource: async () => {},
    },
    effect: () => () => {},
    provide: () => () => {},
    getService: () => undefined,
    requireService: () => {
      throw new Error('no service');
    },
    registerExtension: () => () => {},
    getExtensions: () => [],
    getExtensionsWithOwner: () => [],
  };
}

const ORDER = 'store/order';
const PRODUCT = 'store/product';

describe('refundOrder', () => {
  beforeEach(() => resetContext());

  it('refunds a paid order to the wallet, restores stock, and marks it REFUNDED', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: { items: [{ productId: 'prod-1', quantity: 2 }] },
        total: 19800,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 19800,
        fxRate: null,
      },
      'order-1',
    );
    fake.seed(PRODUCT, { name: '云服务器', stock: 8, status: 'ACTIVE' }, 'prod-1');
    const credit = vi.fn(async () => ({}));
    bindContext(makeCtx(fake, credit));

    const result = (await refundOrder({
      params: { id: 'order-1' },
      body: {},
      user: { id: 'admin-1', role: 'ADMIN' },
    } as never)) as { refunded: number; currency: string };

    expect(result.refunded).toBe(19800);
    expect(result.currency).toBe('CNY');
    expect(fake.all(ORDER)[0]!.spec.state).toBe('REFUNDED');
    expect(fake.all(PRODUCT)[0]!.spec.stock).toBe(10);
    expect(credit).toHaveBeenCalledWith(
      'user-1',
      19800,
      'CNY',
      expect.objectContaining({ type: 'ORDER_REFUND', referenceId: 'order-1' }),
    );
  });

  it('supports a partial refund amount without restoring stock', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: { items: [{ productId: 'p', quantity: 1 }] },
        total: 10000,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 10000,
        fxRate: null,
      },
      'order-2',
    );
    fake.seed(PRODUCT, { name: 'p', stock: 5, status: 'ACTIVE' }, 'p');
    const credit = vi.fn(async () => ({}));
    bindContext(makeCtx(fake, credit));

    const result = (await refundOrder({
      params: { id: 'order-2' },
      body: { amount: 3000 },
      user: { id: 'admin-1', role: 'ADMIN' },
    } as never)) as { refunded: number };
    expect(result.refunded).toBe(3000);
    // 部分退款只退金额，不动物库存。
    expect(fake.all(PRODUCT)[0]!.spec.stock).toBe(5);
  });

  it('rejects a refund exceeding the order total', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: { items: [{ productId: 'p', quantity: 1 }] },
        total: 10000,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 10000,
        fxRate: null,
      },
      'order-3',
    );
    bindContext(makeCtx(fake, vi.fn()));

    await expect(
      refundOrder({
        params: { id: 'order-3' },
        body: { amount: 20000 },
        user: { id: 'a', role: 'ADMIN' },
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses to refund an unpaid order', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: { items: [{ productId: 'p', quantity: 1 }] },
        total: 10000,
        currency: 'CNY',
        state: 'PENDING',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 10000,
        fxRate: null,
      },
      'order-4',
    );
    bindContext(makeCtx(fake, vi.fn()));

    await expect(
      refundOrder({
        params: { id: 'order-4' },
        body: {},
        user: { id: 'a', role: 'ADMIN' },
      } as never),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('does not restore stock for a change-order line (B-3)', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: {
          items: [
            {
              productId: 'prod-1',
              quantity: 1,
              changeServiceId: 'svc-1',
              changeType: 'package',
            },
          ],
        },
        total: 5000,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 5000,
        fxRate: null,
      },
      'order-change',
    );
    // 变配订单从未 reserve 库存；退款不得给目标商品 +stock。
    fake.seed(PRODUCT, { name: '云服务器', stock: 8, status: 'ACTIVE' }, 'prod-1');
    const credit = vi.fn(async () => ({}));
    bindContext(makeCtx(fake, credit));

    const result = (await refundOrder({
      params: { id: 'order-change' },
      body: {},
      user: { id: 'admin-1', role: 'ADMIN' },
    } as never)) as { refunded: number };

    expect(result.refunded).toBe(5000);
    expect(fake.all(PRODUCT)[0]!.spec.stock).toBe(8);
  });

  it('refuses a wallet refund for a partner-prepaid order (B-4)', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        // SP v1 出口建单：平台未实际收款，标记 partner_prepaid。
        items: {
          settlement: 'partner_prepaid',
          items: [{ productId: 'p', quantity: 1, price: 10000, name: 'p' }],
        },
        total: 10000,
        currency: 'CNY',
        state: 'PAID',
        channelCode: 'SP_V1:key',
        settlementCurrency: 'CNY',
        settlementTotal: 10000,
        fxRate: null,
      },
      'order-prepaid',
    );
    const credit = vi.fn(async () => ({}));
    bindContext(makeCtx(fake, credit));

    await expect(
      refundOrder({
        params: { id: 'order-prepaid' },
        body: {},
        user: { id: 'a', role: 'ADMIN' },
      } as never),
    ).rejects.toMatchObject({ status: 409 });
    // 未入账、未改状态。
    expect(credit).not.toHaveBeenCalled();
    expect(fake.all(ORDER)[0]!.spec.state).toBe('PAID');
  });
});
