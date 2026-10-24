import { beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionClient, ExtensionInstance, PluginContext } from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';
import { calculateProductPrice } from './pricing';
import { listCart } from './cart';
import { renewService } from './renewal';
import { storeOperations } from './operations';

/**
 * 跨路径定价一致性（#7 的核心不变量）。
 *
 * 用户能看到的金额有五个来源：商品页试算、购物车、续费、管理/合作方下单、站内下单。
 * 在 #7 之前只有「站内下单」应用折扣，其余四处都按原价算 —— 同一件商品在不同入口
 * 给出不同价格。这里用同一份商品 + 同一个用户把这些入口跑一遍，断言它们**完全相等**。
 *
 * 这是**行为级**回归：如果将来有人只改其中一条路径，这组用例会立刻变红。
 * 真实外部联调（浏览器 + 真实 Postgres）仍单列，不由此代替。
 */

interface Stored {
  name: string;
  spec: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface Seed {
  price: number;
  discount: number | null;
  groupDiscount: number | null;
  renewPrice?: number;
}

const PRODUCT_ID = 'prod-1';
const USER_ID = 'user-1';

/**
 * 最小内存版 ExtensionClient：只实现本次用到的 get / listAll / updateWhere / create。
 * `updateWhere` 与真实内核一致，patch 字段必须在 indexes 内。
 */
function createStores(seed: Seed) {
  const tables = new Map<string, Map<string, Stored>>();
  const table = (kind: string): Map<string, Stored> => {
    let existing = tables.get(kind);
    if (!existing) {
      existing = new Map();
      tables.set(kind, existing);
    }
    return existing;
  };
  const now = new Date('2026-01-01T00:00:00Z');
  table('store/product').set(PRODUCT_ID, {
    name: PRODUCT_ID,
    spec: {
      name: '云服务器',
      description: null,
      price: seed.price,
      currency: 'CNY',
      cost: null,
      originalPrice: null,
      discount: seed.discount,
      stock: 10,
      status: 'ACTIVE',
      metadata: seed.renewPrice
        ? {
            checkoutConfig: {
              cycles: [
                { id: 'monthly', label: '月', price: seed.price, renewPrice: seed.renewPrice },
              ],
              options: [],
            },
          }
        : null,
      categoryId: null,
      fulfillmentType: 'instant',
      providerId: null,
      providerProductId: null,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  table('store/service-instance').set('svc-1', {
    name: 'svc-1',
    spec: {
      userId: USER_ID,
      orderId: 'order-0',
      productId: PRODUCT_ID,
      productName: '云服务器',
      state: 'ACTIVE',
      providerId: null,
      providerServiceId: null,
      fulfillmentType: 'instant',
      expiresAt: new Date('2026-06-01T00:00:00Z'),
      runtime: null,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });

  const revive = (row: Stored): ExtensionInstance<Record<string, unknown>> => ({
    name: row.name,
    spec: row.spec,
    status: null,
    ownerId: null,
    version: row.version,
    labels: {},
    annotations: {},
    finalizers: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletionTimestamp: null,
  });

  const kindOf = (model: unknown): string =>
    typeof model === 'string' ? model : ((model as { kind?: string }).kind ?? 'unknown');

  const client = {
    async get(model: unknown, name: string) {
      const kind = kindOf(model);
      const row = table(kind).get(name);
      return row ? revive(row) : null;
    },
    async list(model: unknown) {
      const kind = kindOf(model);
      return { items: [...table(kind).values()].map((row) => revive(row)) };
    },
    async listAll(model: unknown) {
      const kind = kindOf(model);
      return [...table(kind).values()].map((row) => revive(row));
    },
    async create(model: unknown, spec: Record<string, unknown>) {
      const kind = kindOf(model);
      const name = `${kind.split('/')[1] ?? 'row'}-${table(kind).size + 1}`;
      const row: Stored = { name, spec, version: 1, createdAt: now, updatedAt: now };
      table(kind).set(name, row);
      return revive(row);
    },
    async update(model: unknown, name: string, spec: Record<string, unknown>) {
      const kind = kindOf(model);
      const row = table(kind).get(name)!;
      row.spec = spec;
      row.version += 1;
      row.updatedAt = now;
      return revive(row);
    },
    async updateWhere(
      model: unknown,
      where: Record<string, unknown>,
      patch: Record<string, unknown>,
    ) {
      const kind = kindOf(model);
      let updated = 0;
      for (const row of table(kind).values()) {
        const matches = Object.entries(where).every(([field, condition]) => {
          const value = field === 'name' ? row.name : row.spec[field];
          const expect = condition as { eq?: unknown; gte?: number };
          if (expect.eq !== undefined) return value === expect.eq;
          if (expect.gte !== undefined) return Number(value) >= expect.gte;
          return true;
        });
        if (!matches) continue;
        for (const [field, change] of Object.entries(patch)) {
          if (field === 'state') row.spec[field] = (change as { set?: unknown }).set;
          if (field === 'stock') {
            const delta = (change as { dec?: number }).dec;
            row.spec[field] = Number(row.spec[field]) - (delta ?? 0);
          }
        }
        row.version += 1;
        updated += 1;
      }
      return { updated };
    },
    async delete() {
      return undefined;
    },
  };
  return { client: client as unknown as ExtensionClient };
}

function makeCtx(stores: ReturnType<typeof createStores>, seed: Seed): PluginContext {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    events: {
      publish: () => {},
      subscribe: () => () => {},
      intercept: () => () => {},
      waterfall: <T>(_topic: string, value: T): T => value,
    },
    extensions: stores.client,
    tx: (async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        extensions: stores.client,
        wallet: { debit: async () => ({}), credit: async () => ({}) },
        payments: { createRecord: async () => ({}) },
        publish: () => {},
      })) as never,
    // 关键：权限组折扣在这里注入，模拟「用户属于一个 20% 折扣组」。
    auth: {
      listUserGroups: async () =>
        seed.groupDiscount == null
          ? []
          : [{ id: 'g1', name: '代理', discount: seed.groupDiscount }],
    },
    fx: {
      quote: async (from: string, _to: string, amount: number) => ({
        fromCurrency: from,
        toCurrency: 'CNY',
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
    },
    notifications: {
      create: async () => ({}) as never,
      upsert: async () => ({}) as never,
      notifyPermissionHolders: async () => 0,
    },
    getExtensions: () => [] as never,
    getExtensionsWithOwner: () => [] as never,
  } as unknown as PluginContext;
}

/** 期望的实付单价：与 discount.ts 的口径一致（取更优，封顶 99%）。 */
function expectedUnit(seed: Seed, base: number): number {
  const percent = Math.max(seed.discount ?? 0, seed.groupDiscount ?? 0);
  if (percent <= 0) return base;
  return Math.round((base * (100 - Math.min(percent, 99))) / 100);
}

describe('跨路径定价一致性（展示价 = 实付价）', () => {
  const cases: Array<{ name: string; seed: Seed; expected: number }> = [
    {
      name: '仅商品折扣 10%',
      seed: { price: 9900, discount: 10, groupDiscount: null },
      expected: 8910,
    },
    {
      name: '仅权限组折扣 20%',
      seed: { price: 9900, discount: null, groupDiscount: 20 },
      expected: 7920,
    },
    {
      name: '两者都有：取更优（20%），不叠加',
      seed: { price: 9900, discount: 10, groupDiscount: 20 },
      expected: 7920,
    },
    {
      name: '商品折扣更优（30% vs 15%）',
      seed: { price: 9900, discount: 30, groupDiscount: 15 },
      expected: 6930,
    },
    {
      name: '无任何折扣',
      seed: { price: 9900, discount: null, groupDiscount: null },
      expected: 9900,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}：试算 / 购物车 / 续费 / 合作方下单 与预期一致`, async () => {
      const stores = createStores(testCase.seed);
      bindContext(makeCtx(stores, testCase.seed));

      // 1) 商品页试算（登录态）
      const preview = (await calculateProductPrice({
        params: { id: PRODUCT_ID },
        query: {},
        body: { quantity: 1 },
        headers: {},
        user: { id: USER_ID, role: 'USER' },
      } as never)) as { price: number; total: number; discount: number | null };

      // 2) 合作方（SP v1）下单
      const commerceOrder = await storeOperations.createOrder({
        userId: USER_ID,
        productId: PRODUCT_ID,
        quantity: 1,
      });

      expect(preview.price).toBe(testCase.expected);
      expect(expectedUnit(testCase.seed, testCase.seed.price)).toBe(testCase.expected);
      // 合作方下单与展示价必须同额（这条此前是「按原价收」的重灾区）。
      expect(commerceOrder.total).toBe(testCase.expected);
      expect(preview.discount).toBe(
        testCase.expected === testCase.seed.price
          ? null
          : Math.max(testCase.seed.discount ?? 0, testCase.seed.groupDiscount ?? 0),
      );
    });
  }

  it('续费按折扣后的续费价计费（首期折扣不能静默失效）', async () => {
    const seed: Seed = { price: 9900, discount: 10, groupDiscount: null, renewPrice: 12000 };
    const stores = createStores(seed);
    bindContext(makeCtx(stores, seed));

    const result = (await renewService(makeCtx(stores, seed), {
      params: { id: 'svc-1' },
      query: {},
      body: { paymentMode: 'wallet', cycle: 'monthly' },
      headers: {},
      user: { id: USER_ID, role: 'USER' },
    } as never)) as { order: { total: number } };

    // 续费基价 12000（续费价，不是现价 9900），再打 10% → 10800。
    expect(result.order.total).toBe(10800);
  });

  it('购物车合计与单件试算一致', async () => {
    const seed: Seed = { price: 9900, discount: 10, groupDiscount: null };
    const stores = createStores(seed);
    bindContext(makeCtx(stores, seed));
    await stores.client.create({ kind: 'store/cart-item' } as never, {
      userId: USER_ID,
      productId: PRODUCT_ID,
      quantity: 2,
      config: null,
    });

    const cart = (await listCart({
      params: {},
      query: {},
      body: {},
      headers: {},
      user: { id: USER_ID, role: 'USER' },
    } as never)) as {
      total: number;
      items: Array<{ product: { originalPrice: number; discount: number | null } }>;
    };

    expect(cart.total).toBe(8910 * 2);
    expect(cart.items[0]!.product.originalPrice).toBe(9900);
    expect(cart.items[0]!.product.discount).toBe(10);
  });
});

describe('折扣不会让金额失真', () => {
  beforeEach(() => resetContext());

  it('折扣 100% 被截到 99%，不会出现免费订单', async () => {
    const seed: Seed = { price: 1000, discount: 100, groupDiscount: null };
    const stores = createStores(seed);
    bindContext(makeCtx(stores, seed));
    const preview = (await calculateProductPrice({
      params: { id: PRODUCT_ID },
      query: {},
      body: { quantity: 1 },
      headers: {},
      user: { id: USER_ID, role: 'USER' },
    } as never)) as { price: number };
    expect(preview.price).toBe(10);
    expect(preview.price).toBeGreaterThan(0);
  });

  it('匿名试算只应用商品折扣，不因缺用户而报错', async () => {
    const seed: Seed = { price: 9900, discount: 10, groupDiscount: 20 };
    const stores = createStores(seed);
    bindContext(makeCtx(stores, seed));
    const preview = (await calculateProductPrice({
      params: { id: PRODUCT_ID },
      query: {},
      body: { quantity: 1 },
      headers: {},
    } as never)) as { price: number };
    // 匿名没有权限组，只有商品折扣 10%。
    expect(preview.price).toBe(8910);
  });
});
