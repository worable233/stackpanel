import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CustomModelDefinition,
  ExtensionClient,
  ExtensionInstance,
  FulfillmentProvider,
  PluginContext,
} from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';
import { ExtensionVersionConflict } from '@stackpanel/sdk';
import {
  extendExpiry,
  monthsForCycle,
  applyRenewalOrder,
  reverseRenewalOrder,
  hasRenewalLine,
} from './renewal';
import { runExpirySweep, EXPIRY_MAX_ATTEMPTS } from './expiry';
import { patchServiceInstance } from './repository';

const INDEX_FIELDS: Record<string, Set<string>> = {
  'store/order': new Set(['userId', 'state']),
  'store/service-instance': new Set([
    'userId',
    'orderId',
    'productId',
    'state',
    'providerId',
    'providerServiceId',
    'expiresAtMs',
    'expiryStage',
  ]),
};

/**
 * 内存版 ExtensionClient（与 fulfillment.test.ts 同构），覆盖 renewal/expiry 用到的
 * get/list/listAll/create/update/updateWhere/delete。
 *
 * `updateWhere` 与 `update` 均对齐真实内核语义：patch 字段必须在模型 `indexes` 内、
 * `update` 支持 `expectedVersion` 乐观锁——这样此类回归会在单测暴露，而非只在真实库。
 */
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
      if ('gte' in cond && !(typeof value === 'number' && value >= (cond.gte as number)))
        return false;
      if ('lte' in cond && !(typeof value === 'number' && value <= (cond.lte as number)))
        return false;
    }
    return true;
  };
  const applyPatch = (
    spec: Record<string, unknown>,
    patch: Record<string, { set?: unknown; inc?: number; dec?: number }>,
    kind: string,
  ) => {
    // 与内核 `updateWhere` 对齐：patch 字段必须在模型 indexes 内（见 fulfillment.test.ts 说明）。
    const allowed = INDEX_FIELDS[kind];
    for (const [key, op] of Object.entries(patch)) {
      if (allowed && !allowed.has(key)) {
        throw new Error(`不可更新的字段：${key}`);
      }
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
      table(model.kind).set(name, row);
      return row as unknown as ExtensionInstance;
    },
    async update(
      model: CustomModelDefinition,
      name: string,
      spec: Record<string, unknown>,
      opts?: { expectedVersion?: number },
    ) {
      const row = table(model.kind).get(name);
      if (!row) throw new Error(`not found: ${name}`);
      if (opts?.expectedVersion !== undefined && opts.expectedVersion !== row.version) {
        throw new ExtensionVersionConflict(name);
      }
      row.spec = { ...spec };
      row.version += 1;
      row.updatedAt = new Date();
      return row as unknown as ExtensionInstance;
    },
    async updateWhere(
      model: CustomModelDefinition,
      where: Record<string, Record<string, unknown>>,
      patch: Record<string, { set?: unknown; inc?: number; dec?: number }>,
    ) {
      const rows = [...table(model.kind).values()].filter((row) => matches(row, where));
      for (const row of rows) {
        applyPatch(row.spec, patch, model.kind);
        row.version += 1;
        row.updatedAt = new Date();
      }
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

const notifications: Array<Record<string, unknown>> = [];
/** When true, the notification stub throws (to exercise reliability fallbacks). */
let notificationsFail = false;

function makeCtx(
  fake: ReturnType<typeof createFakeExtensions>,
  provider?: FulfillmentProvider,
): PluginContext {
  const secrets = {
    isAvailable: () => true,
    get: async () => null,
    set: async () => {},
    remove: async () => {},
  };
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
        wallet: { debit: async () => ({}), credit: async () => ({}) },
        payments: { createRecord: async () => ({}) },
        publish: () => {},
      })) as never,
    secrets,
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
    auth: {} as never,
    notifications: {
      create: async (input: Record<string, unknown>) => {
        if (notificationsFail) throw new Error('notifications unavailable');
        notifications.push(input);
        return {} as never;
      },
      upsert: async (input: Record<string, unknown>) => {
        if (notificationsFail) throw new Error('notifications unavailable');
        notifications.push(input);
        return {} as never;
      },
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
    getExtensions: (pointId: string) =>
      (pointId === 'fulfillment.provider' && provider ? [provider] : []) as never,
    getExtensionsWithOwner: (pointId: string) =>
      (pointId === 'fulfillment.provider' && provider
        ? [{ pluginId: 'store', implementation: provider }]
        : []) as never,
  };
}

const SERVICE = 'store/service-instance';
const ORDER = 'store/order';

describe('renewal', () => {
  beforeEach(() => {
    resetContext();
    notifications.length = 0;
  });

  it('maps cycles to months', () => {
    expect(monthsForCycle('yearly')).toBe(12);
    expect(monthsForCycle('quarterly')).toBe(3);
    expect(monthsForCycle('monthly')).toBe(1);
    expect(monthsForCycle(undefined)).toBe(1);
  });

  it('extends from the later of current expiry and now (no lost time after lapse)', () => {
    const now = new Date('2026-01-15T00:00:00Z');
    // still active: extend from existing expiry
    const future = new Date('2026-02-10T00:00:00Z');
    expect(extendExpiry(future, now, 1).toISOString().slice(0, 10)).toBe('2026-03-10');
    // already lapsed: extend from now, not the stale expiry
    const past = new Date('2025-12-01T00:00:00Z');
    expect(extendExpiry(past, now, 1).toISOString().slice(0, 10)).toBe('2026-02-15');
    // never expires: from now
    expect(extendExpiry(null, now, 12).toISOString().slice(0, 10)).toBe('2027-01-15');
  });

  it('applies a renewal order by extending the service expiry and clearing the stage', async () => {
    const fake = createFakeExtensions();
    // far-future expiry so the result is deterministic regardless of wall-clock now
    const expiry = new Date('2099-02-01T00:00:00Z');
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'prod-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: 'svc-1',
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 9900,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'reminded',
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-1',
    );
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: {
          items: [{ productId: 'prod-1', quantity: 1, renewalServiceId: 'svc-1', renewMonths: 3 }],
        },
        total: 9900,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 9900,
        fxRate: null,
      },
      'order-renew-1',
    );
    bindContext(makeCtx(fake));

    await applyRenewalOrder('order-renew-1');

    const svc = fake.all(SERVICE)[0]!;
    expect(svc.spec.expiryStage).toBeNull();
    expect(new Date(svc.spec.expiresAt as string).toISOString().slice(0, 7)).toBe('2099-05');
    expect(svc.spec.expiresAtMs).toBe(new Date(svc.spec.expiresAt as string).getTime());
    // 续费成功通知用户，且用幂等键（重放合并为一条）。
    const renewed = notifications.filter((n) => n.type === 'service.renewed');
    expect(renewed).toHaveLength(1);
    expect(renewed[0]!.dedupeKey).toBe('store:renew:order-renew-1:svc-1');
    expect(renewed[0]!.status).toBe('success');
  });

  it('E-3: renewal notification is idempotent across replays (single deduped row)', async () => {
    const fake = createFakeExtensions();
    const expiry = new Date('2099-02-01T00:00:00Z');
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'prod-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: 'svc-1',
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 9900,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-1',
    );
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: {
          items: [{ productId: 'prod-1', quantity: 1, renewalServiceId: 'svc-1', renewMonths: 1 }],
        },
        total: 9900,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 9900,
        fxRate: null,
      },
      'order-renew-idem',
    );
    bindContext(makeCtx(fake));

    await applyRenewalOrder('order-renew-idem');
    const afterFirst = notifications.filter((n) => n.type === 'service.renewed').length;

    await applyRenewalOrder('order-renew-idem');
    const afterSecond = notifications.filter((n) => n.type === 'service.renewed').length;

    // 第二次 apply 因 renewalApplied 幂等标记跳过；通知幂等键稳定。
    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
  });

  it('recognizes an order containing a renewal line', () => {
    expect(
      hasRenewalLine({
        items: { items: [{ productId: 'p', quantity: 1, renewalServiceId: 's' }] },
      }),
    ).toBe(true);
    expect(hasRenewalLine({ items: { items: [{ productId: 'p', quantity: 1 }] } })).toBe(false);
  });

  it('resumes a suspended service on renewal (back-pay restores it)', async () => {
    const fake = createFakeExtensions();
    const expiry = new Date('2099-02-01T00:00:00Z');
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'prod-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'svc-1',
        state: 'SUSPENDED',
        credentialsRef: null,
        runtime: null,
        amount: 9900,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'suspended',
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-susp',
    );
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: {
          items: [
            { productId: 'prod-1', quantity: 1, renewalServiceId: 'svc-susp', renewMonths: 1 },
          ],
        },
        total: 9900,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 9900,
        fxRate: null,
      },
      'order-renew-susp',
    );
    let resumed = 0;
    const provider = {
      id: 'zjmf',
      name: '智简魔方',
      fulfillmentTypes: ['upstream_service'],
      resume: async () => {
        resumed += 1;
      },
    } as unknown as FulfillmentProvider;
    bindContext(makeCtx(fake, provider));

    await applyRenewalOrder('order-renew-susp');

    const svc = fake.all(SERVICE)[0]!;
    expect(svc.spec.state).toBe('ACTIVE');
    expect(svc.spec.expiryStage).toBeNull();
    expect(resumed).toBe(1);
  });

  it('records the prior expiry and reverses it on full refund', async () => {
    const fake = createFakeExtensions();
    const expiry = new Date('2099-02-01T00:00:00Z');
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'prod-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: 'svc-1',
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 9900,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-rev',
    );
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: {
          items: [
            { productId: 'prod-1', quantity: 1, renewalServiceId: 'svc-rev', renewMonths: 3 },
          ],
        },
        total: 9900,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 9900,
        fxRate: null,
      },
      'order-renew-rev',
    );
    bindContext(makeCtx(fake));

    await applyRenewalOrder('order-renew-rev');
    const extended = fake.all(SERVICE)[0]!;
    expect(new Date(extended.spec.expiresAt as string).toISOString().slice(0, 7)).toBe('2099-05');
    // 回滚点写回订单行
    const orderItems = (fake.all(ORDER)[0]!.spec.items as { items: Array<Record<string, unknown>> })
      .items;
    expect(orderItems[0]!.previousExpiresAt).toBe(expiry.toISOString());

    await reverseRenewalOrder('order-renew-rev');
    const restored = fake.all(SERVICE)[0]!;
    expect(new Date(restored.spec.expiresAt as string).toISOString()).toBe(expiry.toISOString());
    expect(restored.spec.expiryStage).toBeNull();
  });

  it('is idempotent: re-delivering order.paid does not extend twice', async () => {
    const fake = createFakeExtensions();
    const expiry = new Date('2099-02-01T00:00:00Z');
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'prod-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: 'svc-1',
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 9900,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-idem',
    );
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: {
          items: [
            { productId: 'prod-1', quantity: 1, renewalServiceId: 'svc-idem', renewMonths: 1 },
          ],
        },
        total: 9900,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 9900,
        fxRate: null,
      },
      'order-renew-idem',
    );
    bindContext(makeCtx(fake));

    await applyRenewalOrder('order-renew-idem');
    const once = fake.all(SERVICE)[0]!.spec.expiresAt as string;
    await applyRenewalOrder('order-renew-idem');
    const twice = fake.all(SERVICE)[0]!.spec.expiresAt as string;
    expect(twice).toBe(once);
    expect(new Date(twice).toISOString().slice(0, 7)).toBe('2099-03');
  });

  it('F-3: renewal clears the expiry failure counters (no residue from a prior lapse)', async () => {
    const fake = createFakeExtensions();
    const expiry = new Date('2099-02-01T00:00:00Z');
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'prod-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: 'svc-1',
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 9900,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'reminded',
        expiryAttempts: 4, // 上一次到期失败累积的计数
        expiryLastError: 'upstream down',
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-reset',
    );
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: {
          items: [
            { productId: 'prod-1', quantity: 1, renewalServiceId: 'svc-reset', renewMonths: 1 },
          ],
        },
        total: 9900,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 9900,
        fxRate: null,
      },
      'order-renew-reset',
    );
    bindContext(makeCtx(fake));

    await applyRenewalOrder('order-renew-reset');

    const svc = fake.all(SERVICE)[0]!;
    expect(svc.spec.expiryStage).toBeNull();
    expect(svc.spec.expiryAttempts).toBe(0);
    expect(svc.spec.expiryLastError).toBeNull();
  });
});

describe('expiry sweep', () => {
  beforeEach(() => {
    resetContext();
    notifications.length = 0;
    notificationsFail = false;
  });

  it('reminds a service inside the reminder window and marks it reminded', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // +3d
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: null,
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-r',
    );
    bindContext(makeCtx(fake));

    await runExpirySweep(now);

    expect(fake.all(SERVICE)[0]!.spec.expiryStage).toBe('reminded');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe('service.expiring');
  });

  it('does not remind twice', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: null,
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'reminded',
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-r2',
    );
    bindContext(makeCtx(fake));

    await runExpirySweep(now);
    expect(notifications).toHaveLength(0);
  });

  it('keeps an expired service ACTIVE within the grace period', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1d ago (< 3d grace)
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: null,
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'reminded',
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-g',
    );
    bindContext(makeCtx(fake));

    await runExpirySweep(now);
    expect(fake.all(SERVICE)[0]!.spec.state).toBe('ACTIVE');
  });

  it('suspends a service once the grace period elapses', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5d ago (> 3d grace)
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: null,
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'reminded',
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-s',
    );
    bindContext(makeCtx(fake));

    await runExpirySweep(now);
    const svc = fake.all(SERVICE)[0]!;
    expect(svc.spec.state).toBe('SUSPENDED');
    expect(svc.spec.expiryStage).toBe('suspended');
  });

  it('terminates a suspended service after the retention period', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000); // 20d ago (> 3+7d)
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: null,
        state: 'SUSPENDED',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'suspended',
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-t',
    );
    bindContext(makeCtx(fake));

    await runExpirySweep(now);
    const svc = fake.all(SERVICE)[0]!;
    expect(svc.spec.state).toBe('TERMINATED');
    expect(svc.spec.expiryStage).toBe('terminated');
    expect(svc.spec.terminatedAt).toBeTruthy();
  });

  it('does not touch services without an expiry', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '授权',
        fulfillmentType: 'instant',
        providerId: null,
        providerServiceId: null,
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: null,
        expiresAtMs: null,
        expiryStage: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-none',
    );
    bindContext(makeCtx(fake));

    await runExpirySweep(now);
    expect(fake.all(SERVICE)[0]!.spec.state).toBe('ACTIVE');
    expect(notifications).toHaveLength(0);
  });

  it('T1: keeps state ACTIVE and records the failure when suspend provider fails', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // > grace
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'svc-1',
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'reminded',
        expiryAttempts: 0,
        expiryLastError: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-fail-suspend',
    );
    let suspendCalls = 0;
    const provider = {
      id: 'zjmf',
      name: '智简魔方',
      fulfillmentTypes: ['upstream_service'],
      suspend: async () => {
        suspendCalls += 1;
        throw new Error('upstream down');
      },
    } as unknown as FulfillmentProvider;
    bindContext(makeCtx(fake, provider));

    await runExpirySweep(now);

    const svc = fake.all(SERVICE)[0]!;
    expect(svc.spec.state).toBe('ACTIVE');
    expect(svc.spec.expiryStage).toBe('suspending');
    expect(svc.spec.expiryAttempts).toBe(1);
    expect(svc.spec.expiryLastError).toBe('upstream down');
    expect(suspendCalls).toBe(1);
    expect(notifications.filter((n) => n.type === 'service.suspended')).toHaveLength(0);
  });

  it('T2: retries suspend and reaches the terminal state once the provider succeeds', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'svc-1',
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'reminded',
        expiryAttempts: 0,
        expiryLastError: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-retry-suspend',
    );
    let fail = true;
    const provider = {
      id: 'zjmf',
      name: '智简魔方',
      fulfillmentTypes: ['upstream_service'],
      suspend: async () => {
        if (fail) throw new Error('upstream down');
      },
    } as unknown as FulfillmentProvider;
    bindContext(makeCtx(fake, provider));

    await runExpirySweep(now); // first attempt fails
    fail = false;
    await runExpirySweep(now); // retry succeeds

    const svc = fake.all(SERVICE)[0]!;
    expect(svc.spec.state).toBe('SUSPENDED');
    expect(svc.spec.expiryStage).toBe('suspended');
    expect(svc.spec.expiryAttempts).toBe(0);
    expect(svc.spec.expiryLastError).toBeNull();
    expect(notifications.filter((n) => n.type === 'service.suspended')).toHaveLength(1);
  });

  it('T3: stops auto-retrying once attempts reach the cap (provider not called)', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'svc-1',
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'suspending',
        expiryAttempts: EXPIRY_MAX_ATTEMPTS,
        expiryLastError: 'upstream down',
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-capped',
    );
    let suspendCalls = 0;
    const provider = {
      id: 'zjmf',
      name: '智简魔方',
      fulfillmentTypes: ['upstream_service'],
      suspend: async () => {
        suspendCalls += 1;
      },
    } as unknown as FulfillmentProvider;
    bindContext(makeCtx(fake, provider));

    await runExpirySweep(now);

    const svc = fake.all(SERVICE)[0]!;
    expect(suspendCalls).toBe(0);
    expect(svc.spec.state).toBe('ACTIVE');
    expect(svc.spec.expiryStage).toBe('suspending');
    expect(notifications).toHaveLength(0);
  });

  it('T4: keeps state SUSPENDED and records the failure when terminate provider fails', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000); // > grace + retention
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'svc-1',
        state: 'SUSPENDED',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'suspended',
        expiryAttempts: 0,
        expiryLastError: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-fail-terminate',
    );
    const provider = {
      id: 'zjmf',
      name: '智简魔方',
      fulfillmentTypes: ['upstream_service'],
      terminate: async () => {
        throw new Error('upstream down');
      },
    } as unknown as FulfillmentProvider;
    bindContext(makeCtx(fake, provider));

    await runExpirySweep(now);

    const svc = fake.all(SERVICE)[0]!;
    expect(svc.spec.state).toBe('SUSPENDED');
    expect(svc.spec.expiryStage).toBe('terminating');
    expect(svc.spec.expiryAttempts).toBe(1);
    expect(notifications.filter((n) => n.type === 'service.terminated')).toHaveLength(0);
  });

  it('T5: retries terminate and reaches TERMINATED once the provider succeeds', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'svc-1',
        state: 'SUSPENDED',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'suspended',
        expiryAttempts: 0,
        expiryLastError: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-retry-terminate',
    );
    let fail = true;
    const provider = {
      id: 'zjmf',
      name: '智简魔方',
      fulfillmentTypes: ['upstream_service'],
      terminate: async () => {
        if (fail) throw new Error('upstream down');
      },
    } as unknown as FulfillmentProvider;
    bindContext(makeCtx(fake, provider));

    await runExpirySweep(now); // fails
    fail = false;
    await runExpirySweep(now); // succeeds

    const svc = fake.all(SERVICE)[0]!;
    expect(svc.spec.state).toBe('TERMINATED');
    expect(svc.spec.expiryStage).toBe('terminated');
    expect(svc.spec.terminatedAt).toBeTruthy();
    expect(svc.spec.expiryAttempts).toBe(0);
    expect(notifications.filter((n) => n.type === 'service.terminated')).toHaveLength(1);
  });

  it('T6: reminder batch skips already-reminded services so later ones get reminded', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // inside window
    // 50 already-reminded with the earliest expiry, plus 1 un-reminded later.
    for (let i = 0; i < 50; i += 1) {
      const e = new Date(expiry.getTime() + i);
      fake.seed(
        SERVICE,
        {
          userId: 'user-1',
          orderId: null,
          productId: 'p',
          productName: '云服务器',
          fulfillmentType: 'upstream_service',
          providerId: null,
          providerServiceId: null,
          state: 'ACTIVE',
          credentialsRef: null,
          runtime: null,
          amount: 100,
          currency: 'CNY',
          expiresAt: e.toISOString(),
          expiresAtMs: e.getTime(),
          expiryStage: 'reminded',
          expiryAttempts: 0,
          expiryLastError: null,
          provisionedAt: null,
          terminatedAt: null,
        },
        `svc-reminded-${i}`,
      );
    }
    const lastExpiry = new Date(expiry.getTime() + 100_000);
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: null,
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: lastExpiry.toISOString(),
        expiresAtMs: lastExpiry.getTime(),
        expiryStage: null,
        expiryAttempts: 0,
        expiryLastError: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-late',
    );
    bindContext(makeCtx(fake));

    await runExpirySweep(now);

    const late = fake
      .all(SERVICE)
      .find((row) => row.name === 'svc-late')!;
    expect(late.spec.expiryStage).toBe('reminded');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.data).toMatchObject({ serviceId: 'svc-late' });
  });

  it('T7: is idempotent — repeated sweeps notify and reach the terminal state only once', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'svc-1',
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'reminded',
        expiryAttempts: 0,
        expiryLastError: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-idem-sweep',
    );
    let suspendCalls = 0;
    const provider = {
      id: 'zjmf',
      name: '智简魔方',
      fulfillmentTypes: ['upstream_service'],
      suspend: async () => {
        suspendCalls += 1;
      },
    } as unknown as FulfillmentProvider;
    bindContext(makeCtx(fake, provider));

    await runExpirySweep(now);
    await runExpirySweep(now);

    const svc = fake.all(SERVICE)[0]!;
    expect(svc.spec.state).toBe('SUSPENDED');
    expect(svc.spec.expiryStage).toBe('suspended');
    expect(suspendCalls).toBe(1);
    expect(notifications.filter((n) => n.type === 'service.suspended')).toHaveLength(1);
  });

  it('E-1: reminder is retried when notification delivery fails (stage released)', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // inside window
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: null,
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: null,
        expiryAttempts: 0,
        expiryLastError: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-r-retry',
    );
    bindContext(makeCtx(fake));

    notificationsFail = true;
    await runExpirySweep(now);
    // Delivery failed: stage must NOT remain 'reminded', so a later sweep retries.
    expect(fake.all(SERVICE)[0]!.spec.expiryStage).toBeNull();
    expect(notifications).toHaveLength(0);

    notificationsFail = false;
    await runExpirySweep(now);
    expect(fake.all(SERVICE)[0]!.spec.expiryStage).toBe('reminded');
    expect(notifications.filter((n) => n.type === 'service.expiring')).toHaveLength(1);
  });

  it('E-2: suspend fails loudly (stays retryable) when an upstream-bound service has no provider', async () => {
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // > grace
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf', // bound upstream, but the provider is not registered
        providerServiceId: 'svc-1',
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'reminded',
        expiryAttempts: 0,
        expiryLastError: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-no-provider',
    );
    bindContext(makeCtx(fake)); // no provider registered

    await runExpirySweep(now);

    const svc = fake.all(SERVICE)[0]!;
    // Must NOT report success: state stays ACTIVE, stage stays retryable, no false通知.
    expect(svc.spec.state).toBe('ACTIVE');
    expect(svc.spec.expiryStage).toBe('suspending');
    expect(svc.spec.expiryAttempts).toBe(1);
    expect(notifications.filter((n) => n.type === 'service.suspended')).toHaveLength(0);
  });

  it('F-2: patchServiceInstance abandons the write when the row changed since it was read', async () => {
    // 回归：整行读改写必须带乐观锁。模拟「读到之后被并发改动」——直接用过期版本号写入。
    const fake = createFakeExtensions();
    const now = new Date('2026-01-15T00:00:00Z');
    const expiry = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: null,
        productId: 'p',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        providerServiceId: null,
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: null,
        amount: 100,
        currency: 'CNY',
        expiresAt: expiry.toISOString(),
        expiresAtMs: expiry.getTime(),
        expiryStage: 'suspending',
        expiryAttempts: 0,
        expiryLastError: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-lock',
    );
    bindContext(makeCtx(fake));

    // 模拟「读到之后、写入之前」被并发改动：get 返回陈旧版本（1），而存储行已是版本 2。
    // patchServiceInstance 以读到的版本做乐观锁，写入应冲突 → 返回 false 且不落库。
    const stored = fake.all(SERVICE)[0]!;
    stored.version = 2;
    const originalGet = fake.client.get.bind(fake.client);
    fake.client.get = (async (model: CustomModelDefinition, name: string) => {
      const row = await originalGet(model, name);
      return row && name === 'svc-lock' ? { ...row, version: 1 } : row;
    }) as typeof fake.client.get;

    const ok = await patchServiceInstance('svc-lock', 'suspending', {
      state: { set: 'SUSPENDED' },
      expiryStage: { set: 'suspended' },
    });
    expect(ok).toBe(false);
    expect(fake.all(SERVICE)[0]!.spec.state).toBe('ACTIVE');
    expect(fake.all(SERVICE)[0]!.spec.expiryStage).toBe('suspending');
  });
});
