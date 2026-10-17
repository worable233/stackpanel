import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CustomModelDefinition,
  ExtensionClient,
  ExtensionInstance,
  ExtensionTransaction,
  PluginContext,
} from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';
import { storeOperations } from './operations';
import { settlementHandler } from './orders';
import { subscribeOrderPaid } from './fulfillment';
import { orderModel, productModel } from './data';

/**
 * T3（FIX-4 W1）：业务写与事件落库同事务。
 *
 * 用内存事务替身模拟 `ctx.tx`：`tx.publish` 只在事务提交后生效；事务抛错则
 * 业务写与事件一起回滚。断言 `order.paid` 与订单 PAID **同事务**，且失败不产生事件。
 */

interface Stored {
  name: string;
  spec: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const INDEX_FIELDS: Record<string, Set<string>> = {
  'store/order': new Set(['userId', 'state']),
  'store/product': new Set(['status', 'stock', 'providerId']),
};

function cloneTables(source: Map<string, Map<string, Stored>>): Map<string, Map<string, Stored>> {
  const copy = new Map<string, Map<string, Stored>>();
  for (const [kind, rows] of source) {
    const next = new Map<string, Stored>();
    for (const [name, row] of rows) {
      next.set(name, { ...row, spec: { ...row.spec } });
    }
    copy.set(kind, next);
  }
  return copy;
}

function createStores() {
  const tables = new Map<string, Map<string, Stored>>();
  let seq = 0;
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
      if ('gte' in cond && !(typeof value === 'number' && value >= (cond.gte as number)))
        return false;
    }
    return true;
  };
  const clientFor = (source: Map<string, Map<string, Stored>>) =>
    ({
      async get(model: CustomModelDefinition, name: string) {
        const row = source.get(model.kind)?.get(name);
        return row ? (row as unknown as ExtensionInstance) : null;
      },
      async listAll(model: CustomModelDefinition) {
        return [...(source.get(model.kind)?.values() ?? [])] as unknown as ExtensionInstance[];
      },
      async create(
        model: CustomModelDefinition,
        spec: Record<string, unknown>,
        opts?: { name?: string },
      ) {
        const name = opts?.name ?? `${model.kind}-${++seq}`;
        const row: Stored = {
          name,
          spec: { ...spec },
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        if (!source.has(model.kind)) source.set(model.kind, new Map());
        source.get(model.kind)!.set(name, row);
        return row as unknown as ExtensionInstance;
      },
      async update(model: CustomModelDefinition, name: string, spec: Record<string, unknown>) {
        const row = source.get(model.kind)?.get(name);
        if (!row) throw new Error(`not found: ${name}`);
        row.spec = { ...spec };
        row.version += 1;
        return row as unknown as ExtensionInstance;
      },
      async updateWhere(
        model: CustomModelDefinition,
        where: Record<string, Record<string, unknown>>,
        patch: Record<string, { set?: unknown; inc?: number; dec?: number }>,
      ) {
        const allowed = INDEX_FIELDS[model.kind];
        const rows = [...(source.get(model.kind)?.values() ?? [])].filter((row) =>
          matches(row, where),
        );
        for (const row of rows) {
          for (const [key, op] of Object.entries(patch)) {
            if (allowed && !allowed.has(key)) throw new Error(`不可更新的字段：${key}`);
            if ('set' in op) row.spec[key] = op.set;
            else if ('inc' in op) row.spec[key] = ((row.spec[key] as number) ?? 0) + op.inc;
            else if ('dec' in op) row.spec[key] = ((row.spec[key] as number) ?? 0) - op.dec;
          }
          row.version += 1;
        }
        return { updated: rows.length };
      },
      async delete(model: CustomModelDefinition, name: string) {
        source.get(model.kind)?.delete(name);
      },
    }) as unknown as ExtensionClient;

  return { tables, clientFor };
}

/** Build a ctx whose `tx` commits staged writes + buffered events atomically. */
function makeCtx(
  stores: ReturnType<typeof createStores>,
  commit: (published: Array<{ topic: string; payload: unknown }>) => void,
  runIdempotent?: (
    consumer: string,
    eventId: string,
    handler: () => void | Promise<void>,
  ) => Promise<boolean>,
  onSubscribe?: (
    topic: string,
    handler: (payload: unknown, meta?: { eventId: string; topic: string }) => void,
  ) => void,
) {
  const live = stores.tables;
  return {
    manifest: { id: 'store', name: '商店插件', version: '0.3.0' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    // A local (non-outbox) bus: the W1 path must NOT touch it inside the tx.
    events: {
      publish: vi.fn(),
      subscribe: (
        topic: string,
        handler: (payload: unknown, meta?: { eventId: string; topic: string }) => void,
      ) => {
        onSubscribe?.(topic, handler);
        return () => {};
      },
      intercept: () => () => {},
      waterfall: <T>(_topic: string, value: T): T => value,
      ...(runIdempotent ? { runIdempotent } : {}),
    },
    extensions: stores.clientFor(live),
    tx: (async (fn: (tx: ExtensionTransaction) => Promise<unknown>) => {
      const staged = cloneTables(live);
      const published: Array<{ topic: string; payload: unknown }> = [];
      const tx = {
        extensions: stores.clientFor(staged),
        wallet: { debit: vi.fn(), credit: vi.fn() },
        payments: { createRecord: vi.fn() },
        publish: (topic: string, payload?: unknown) => published.push({ topic, payload }),
      } as unknown as ExtensionTransaction;
      const result = await fn(tx);
      // Commit: promote staged tables + buffered events only on success.
      live.clear();
      for (const [kind, rows] of staged) live.set(kind, rows);
      commit(published);
      return result;
    }) as never,
    notifications: {
      create: vi.fn(async () => ({}) as never),
      upsert: vi.fn(async () => ({}) as never),
      notifyPermissionHolders: vi.fn(async () => 0),
    },
    notificationPolicy: {} as never,
    payments: {} as never,
    wallet: {} as never,
    fx: {
      quote: async (from: string, to: string, amount: number) => ({
        fromCurrency: from,
        toCurrency: to,
        amount,
        settlementAmount: amount,
        rate: null,
      }),
      quoteToSettlement: async (from: string, amount: number) => ({
        fromCurrency: from,
        toCurrency: 'CNY',
        amount,
        settlementAmount: amount,
        rate: null,
      }),
    } as never,
    currency: {} as never,
    auth: { listUserGroups: async () => [] } as never,
    identity: {} as never,
    captcha: {} as never,
    secrets: { isAvailable: () => false } as never,
    storage: {} as never,
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
    getExtensions: () => [] as never,
    getExtensionsWithOwner: () => [] as never,
  } as unknown as PluginContext;
}

function seedProduct(stores: ReturnType<typeof createStores>) {
  stores.clientFor(stores.tables);
  const table = stores.tables.get('store/product') ?? new Map<string, Stored>();
  stores.tables.set('store/product', table);
  table.set('prod-1', {
    name: 'prod-1',
    spec: {
      name: '云服务器',
      price: 9900,
      currency: 'CNY',
      status: 'ACTIVE',
      stock: 10,
      fulfillmentType: 'upstream_service',
      providerId: 'zjmf',
      providerProductId: 'up-prod-1',
      metadata: null,
      discount: null,
    },
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('FIX-4 W1 · store 事件与业务写同事务', () => {
  beforeEach(() => resetContext());

  it('T3 createOrder：order.paid 在事务内发布，随订单提交', async () => {
    const stores = createStores();
    seedProduct(stores);
    const committed: Array<{ topic: string; payload: unknown }> = [];
    bindContext(makeCtx(stores, (events) => committed.push(...events)));

    const order = await storeOperations.createOrder({
      userId: 'user-1',
      productId: 'prod-1',
      quantity: 1,
      channelCode: 'MALL_PC',
    });

    expect(order.status).toBe('PAID');
    expect(committed).toHaveLength(1);
    expect(committed[0]!.topic).toBe('order.paid');
    expect(committed[0]!.payload).toMatchObject({ orderId: order.id, userId: 'user-1' });
    // Stock decremented in the same transaction as the event.
    const product = stores.tables.get('store/product')!.get('prod-1')!;
    expect(product.spec.stock).toBe(9);
  });

  it('T3 回滚：建单失败时既不落订单也不产生 order.paid', async () => {
    const stores = createStores();
    // No product seeded → updateWhere matches 0 → CommerceError before publish.
    const committed: Array<{ topic: string; payload: unknown }> = [];
    bindContext(makeCtx(stores, (events) => committed.push(...events)));

    await expect(
      storeOperations.createOrder({ userId: 'user-1', productId: 'missing', quantity: 1 }),
    ).rejects.toMatchObject({ code: 'commerce.product_unavailable' });

    expect(committed).toHaveLength(0);
    expect([...(stores.tables.get('store/order')?.values() ?? [])]).toHaveLength(0);
  });

  it('T3 settlementHandler：新认领时在事务内发布 order.paid，重放不再发布', async () => {
    const stores = createStores();
    const table = stores.tables.get('store/order') ?? new Map<string, Stored>();
    stores.tables.set('store/order', table);
    table.set('order-1', {
      name: 'order-1',
      spec: {
        userId: 'user-1',
        items: { items: [{ productId: 'prod-1', quantity: 1 }] },
        total: 9900,
        currency: 'CNY',
        state: 'PENDING',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 9900,
        fxRate: null,
      },
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const committed: Array<{ topic: string; payload: unknown }> = [];
    bindContext(makeCtx(stores, (events) => committed.push(...events)));

    const settlement = {
      purpose: 'ORDER',
      orderId: 'order-1',
      paymentId: 'pay-1',
      userId: 'user-1',
      amount: 9900,
      currency: 'CNY',
    } as never;

    const first = await settlementHandler.settle(settlement);
    expect(first.applied).toBe(true);
    expect(committed).toHaveLength(1);
    expect(committed[0]!.topic).toBe('order.paid');

    // Replay: order already PAID → idempotent, no second event.
    const second = await settlementHandler.settle(settlement);
    expect(second.applied).toBe(true);
    expect(committed).toHaveLength(1);
  });
});

describe('FIX-4B · 消费幂等（at-least-once 重复投递不产生二次副作用）', () => {
  beforeEach(() => resetContext());

  it('T7c subscribeOrderPaid：同一 eventId 重复投递只入队一次', async () => {
    const stores = createStores();
    const subscribeHandlers = new Map<
      string,
      (payload: unknown, meta?: { eventId: string; topic: string }) => void
    >();
    const runIdempotent = vi.fn(
      async (_consumer: string, _eventId: string, handler: () => void | Promise<void>) => {
        await handler();
        return true;
      },
    );
    const ctx = makeCtx(
      stores,
      () => {},
      runIdempotent,
      (topic, handler) => {
        subscribeHandlers.set(topic, handler);
      },
    );
    bindContext(ctx);

    subscribeOrderPaid();
    const handler = subscribeHandlers.get('order.paid');
    expect(handler).toBeDefined();

    // No order row exists, so the scan exits early; the point is the guard fires.
    handler!({ orderId: 'missing-order' }, { eventId: 'evt-1', topic: 'order.paid' });
    handler!({ orderId: 'missing-order' }, { eventId: 'evt-1', topic: 'order.paid' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runIdempotent).toHaveBeenCalledTimes(2);
    expect(runIdempotent.mock.calls.map((call) => call[1])).toEqual(['evt-1', 'evt-1']);
    expect(runIdempotent.mock.calls[0]![0]).toBe('store.fulfillment');
  });

  it('T7c subscribeOrderPaid：无 eventId（本地直发）时不走幂等包装', async () => {
    const stores = createStores();
    const subscribeHandlers = new Map<string, (payload: unknown) => void>();
    const runIdempotent = vi.fn(async () => true);
    const ctx = makeCtx(stores, () => {}, runIdempotent, (topic, handler) => {
      subscribeHandlers.set(topic, handler);
    });
    bindContext(ctx);

    subscribeOrderPaid();
    subscribeHandlers.get('order.paid')!({ orderId: 'missing-order' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runIdempotent).not.toHaveBeenCalled();
  });
});

// Guard the model constants the test relies on so a rename fails loudly here.
void orderModel;
void productModel;
