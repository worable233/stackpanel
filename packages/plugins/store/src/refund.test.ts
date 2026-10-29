import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CustomModelDefinition,
  ExtensionClient,
  ExtensionInstance,
  PluginContext,
} from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';
import { refundOrder, reviewRefundRequest } from './refund';

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
      // The real extension client only accepts physical columns (the fields
      // declared in `indexes`); anything else throws「不可更新的字段」and the HTTP
      // call 422s. Enforcing it here keeps that class of bug visible in tests.
      const columns = new Set((model.indexes ?? []).flatMap((index) => index.fields));
      for (const field of Object.keys(patch)) {
        if (!columns.has(field)) throw new Error(`不可更新的字段：${field}`);
      }
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
  publish: (topic: string, payload?: unknown) => void = () => {},
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
        publish,
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
    currency: {} as never,
    auth: {} as never,
    notifications: {
      create: async () => ({}) as never,
      upsert: async () => ({}) as never,
      notifyPermissionHolders: async () => 0,
    } as never,
    notificationPolicy: {} as never,
    identity: {} as never,
    captcha: {} as never,
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

  it('F-3: publishes order.refunded inside the transaction (atomic with the state change)', async () => {
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
      'order-tx',
    );
    const published: Array<{ topic: string; payload: unknown }> = [];
    const credit = vi.fn(async () => ({}));
    bindContext(makeCtx(fake, credit, (topic, payload) => published.push({ topic, payload })));

    await refundOrder({
      params: { id: 'order-tx' },
      body: {},
      user: { id: 'a', role: 'ADMIN' },
    } as never);

    expect(published).toEqual([
      {
        topic: 'order.refunded',
        payload: { orderId: 'order-tx', amount: 10000, userId: 'user-1', full: true },
      },
    ]);
  });
});

describe('reviewRefundRequest', () => {
  beforeEach(() => resetContext());

  /**
   * 回归：审核通过曾经整笔 422。两处原因都会在这里复现——
   * 1) `reviewerId` 只存在 spec 里，不是物理列，不能出现在 `updateWhere` 的 patch；
   * 2) 申请没有 `reason`（null）时不能原样透传给 `refundOrder` 的 `reason?: string`。
   */
  it('approves a pending request without a reason and credits the wallet', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: { items: [{ productId: 'prod-1', quantity: 1 }] },
        total: 5000,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 5000,
        fxRate: null,
      },
      'order-9',
    );
    fake.seed(PRODUCT, { name: '云服务器', stock: 3, status: 'ACTIVE' }, 'prod-1');
    fake.seed(
      'store/refund-request',
      {
        orderId: 'order-9',
        userId: 'user-1',
        amount: 5000,
        currency: 'CNY',
        reason: null,
        state: 'PENDING',
        reviewerId: null,
        reviewReason: null,
        failureReason: null,
        destination: 'WALLET',
        idempotencyKey: null,
      },
      'rr-1',
    );
    const credit = vi.fn(async () => ({}));
    bindContext(makeCtx(fake, credit));

    const result = (await reviewRefundRequest({
      params: { id: 'rr-1' },
      body: { decision: 'approve' },
      user: { id: 'admin-1', role: 'ADMIN' },
    } as never)) as { request: { status: string } };

    expect(result.request.status).toBe('SUCCEEDED');
    expect(fake.all('store/refund-request')[0]!.spec).toMatchObject({
      state: 'SUCCEEDED',
      reviewerId: 'admin-1',
      failureReason: null,
    });
    expect(credit).toHaveBeenCalledWith(
      'user-1',
      5000,
      'CNY',
      expect.objectContaining({ type: 'ORDER_REFUND' }),
    );
  });
});

/**
 * 开通结果无法由 provider 证明时（fence 之前就失败），订单会夹在「不能交付」和
 * 「不能退款」之间。这组用例锁住新出口的边界：只有显式声明才放行，且声明永远
 * 不能覆盖“上游对象确实存在”的硬证据。
 */
describe('refundOrder · 开通结果待核对', () => {
  const TASK = 'store/delivery-task';
  const SERVICE = 'store/service-instance';

  beforeEach(() => resetContext());

  function seedOrder(options: { taskState?: string; service?: Record<string, unknown> } = {}) {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: { items: [{ productId: 'prod-1', quantity: 1 }] },
        total: 6635,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 6635,
        fxRate: null,
      },
      'order-1',
    );
    fake.seed(PRODUCT, { name: '云服务器', stock: 7, status: 'ACTIVE' }, 'prod-1');
    fake.seed(
      TASK,
      { orderId: 'order-1', state: options.taskState ?? 'REQUIRES_RECONCILIATION' },
      'task-1',
    );
    if (options.service) {
      fake.seed(SERVICE, { orderId: 'order-1', ...options.service }, 'svc-1');
    }
    const credit = vi.fn(async (..._args: unknown[]) => ({}));
    bindContext(makeCtx(fake, credit));
    return { fake, credit };
  }

  const refund = (body: Record<string, unknown> = {}) =>
    refundOrder({
      params: { id: 'order-1' },
      body,
      user: { id: 'admin-1', role: 'ADMIN' },
    } as never);

  it('未声明时拒绝退款，并给出可判别的错误码', async () => {
    const { fake, credit } = seedOrder();
    await expect(refund()).rejects.toMatchObject({
      status: 409,
      code: 'store.refund.needs_upstream_attestation',
    });
    expect(fake.all(ORDER)[0]!.spec.state).toBe('PAID');
    expect(fake.all(TASK)[0]!.spec.state).toBe('REQUIRES_RECONCILIATION');
    expect(credit).not.toHaveBeenCalled();
  });

  it('运营声明无上游实例后退款成功，并把卡住的任务置为已取消', async () => {
    const { fake, credit } = seedOrder();
    const result = (await refund({
      confirmNoUpstreamInstance: true,
      reason: '上游未返回账单',
    })) as { refunded: number };

    expect(result.refunded).toBe(6635);
    expect(fake.all(ORDER)[0]!.spec.state).toBe('REFUNDED');
    expect(fake.all(TASK)[0]!.spec.state).toBe('CANCELLED');
    expect(credit).toHaveBeenCalledWith(
      'user-1',
      6635,
      'CNY',
      expect.objectContaining({ type: 'ORDER_REFUND' }),
    );
    // 声明必须留在账本备注里：这条钱是“人工断言”而非机器证据换来的。
    expect(credit.mock.calls[0]?.[3]).toMatchObject({
      note: expect.stringContaining('运营确认上游无实例'),
    });
  });

  it('已有上游实例 ID 时，声明无效（证据高于断言）', async () => {
    const { fake, credit } = seedOrder({
      service: { state: 'ACTIVE', providerServiceId: 'remote-42' },
    });
    await expect(refund({ confirmNoUpstreamInstance: true })).rejects.toMatchObject({
      status: 409,
      code: 'store.refund.upstream_instance_exists',
    });
    expect(fake.all(ORDER)[0]!.spec.state).toBe('PAID');
    expect(credit).not.toHaveBeenCalled();
  });

  it('开通仍在执行时，声明无效', async () => {
    const { fake, credit } = seedOrder({ taskState: 'RUNNING' });
    await expect(refund({ confirmNoUpstreamInstance: true })).rejects.toMatchObject({
      status: 409,
      code: 'store.refund.provisioning_running',
    });
    expect(fake.all(ORDER)[0]!.spec.state).toBe('PAID');
    expect(fake.all(TASK)[0]!.spec.state).toBe('RUNNING');
    expect(credit).not.toHaveBeenCalled();
  });
});
