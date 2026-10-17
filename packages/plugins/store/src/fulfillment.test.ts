import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CustomModelDefinition,
  ExtensionClient,
  ExtensionInstance,
  FulfillmentProvider,
  PluginContext,
} from '@stackpanel/sdk';
import { CommerceError, ExtensionVersionConflict } from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';
import {
  enqueueOrderFulfillment,
  getMyService,
  listMyServices,
  processDue,
  runMyServiceAction,
} from './fulfillment';
import { applyChangeOrder } from './changes';
import { storeOperations } from './operations';

interface Stored {
  name: string;
  spec: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 最小内存版 ExtensionClient，按模型 kind 存储实例，覆盖 fulfillment 用到的
 * get/list/listAll/create/update/updateWhere/delete。
 */
const INDEX_FIELDS: Record<string, Set<string>> = {
  'store/order': new Set(['userId', 'state']),
  'store/product': new Set(['status', 'categoryId', 'stock', 'providerId']),
  'store/delivery-task': new Set(['state', 'orderId', 'userId', 'nextAttemptAtMs', 'attempts']),
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

function createFakeExtensions() {
  const tables = new Map<string, Map<string, Stored>>();
  let seq = 0;
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
    // 与内核 `updateWhere` 对齐：patch 字段必须在模型 indexes 内，否则抛错
    // （真实内核 `client.ts` 抛 `extension.validation_error`）。这条断言正是当初能
    // 掩盖 `reclaimTask` 写未索引 `error` 的原因——补齐后防止再次回归。
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

function makeProvider(): { provider: FulfillmentProvider; provision: ReturnType<typeof vi.fn> } {
  const provision = vi.fn(async () => ({
    status: 'ACTIVE',
    providerServiceId: 'svc-upstream-1',
    credentialsRef: 'svc.abc',
    runtime: { ip: '203.0.113.10', upstreamId: 'up-1', status: 'ACTIVE' },
  }));
  const provider = {
    id: 'zjmf',
    name: '智简魔方',
    fulfillmentTypes: ['upstream_service'],
    provision,
  } as unknown as FulfillmentProvider;
  return { provider, provision };
}

function makeCtx(
  fake: ReturnType<typeof createFakeExtensions>,
  provider: FulfillmentProvider,
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
    tx: (async () => {
      throw new Error('no tx in this test');
    }) as never,
    secrets,
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
    getExtensions: (pointId: string) =>
      (pointId === 'fulfillment.provider' ? [provider] : []) as never,
    getExtensionsWithOwner: (pointId: string) =>
      (pointId === 'fulfillment.provider'
        ? [{ pluginId: 'store', implementation: provider }]
        : []) as never,
  };
}

const ORDER = 'store/order';
const PRODUCT = 'store/product';
const TASK = 'store/delivery-task';
const SERVICE = 'store/service-instance';

describe('store fulfillment dispatcher', () => {
  beforeEach(() => {
    resetContext();
  });

  it('creates delivery tasks for paid order lines and provisions services', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: { items: [{ productId: 'prod-1', quantity: 1 }] },
        total: 9900,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 9900,
        fxRate: null,
      },
      'order-1',
    );
    fake.seed(
      PRODUCT,
      {
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
      'prod-1',
    );
    const { provider, provision } = makeProvider();
    bindContext(makeCtx(fake, provider));

    await enqueueOrderFulfillment('order-1');

    const tasks = fake.all(TASK);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.spec).toMatchObject({
      state: 'SUCCEEDED',
      orderId: 'order-1',
      serviceId: expect.any(String),
    });
    const services = fake.all(SERVICE);
    expect(services).toHaveLength(1);
    expect(services[0]!.spec).toMatchObject({
      userId: 'user-1',
      orderId: 'order-1',
      productId: 'prod-1',
      state: 'ACTIVE',
      providerServiceId: 'svc-upstream-1',
      credentialsRef: 'svc.abc',
    });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision.mock.calls[0]?.[0].product).toMatchObject({
      id: 'prod-1',
      providerProductId: 'up-prod-1',
    });
  });

  it('retries with backoff then fails after attempts exhaust', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      {
        userId: 'user-2',
        items: { items: [{ productId: 'prod-2', quantity: 1 }] },
        total: 100,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 100,
        fxRate: null,
      },
      'order-2',
    );
    fake.seed(
      PRODUCT,
      {
        name: '坏商品',
        price: 100,
        currency: 'CNY',
        status: 'ACTIVE',
        stock: 5,
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerProductId: 'up-prod-2',
        metadata: null,
        discount: null,
      },
      'prod-2',
    );
    const { provider, provision } = makeProvider();
    provision.mockRejectedValue(new Error('上游超时'));
    bindContext(makeCtx(fake, provider));

    await enqueueOrderFulfillment('order-2');

    // 第一次失败后进入退避重试：仍是 PENDING，并记录了错误与下次执行时间
    const task = fake.all(TASK)[0]!;
    expect(task.spec.state).toBe('PENDING');
    expect(task.spec.error).toBe('上游超时');
    expect(task.spec.nextAttemptAtMs).toBeGreaterThan(0);

    // 耗尽重试次数（attempts 达到 maxAttempts）后置为 FAILED
    const taskModel = { kind: TASK } as CustomModelDefinition;
    await fake.client.update(taskModel, task.name, {
      ...task.spec,
      attempts: task.spec.maxAttempts as number,
      nextAttemptAtMs: 0,
    });
    await processDue();
    expect(fake.all(TASK)[0]?.spec.state).toBe('FAILED');
    expect(fake.all(TASK)[0]?.spec.error).toBe('上游超时');
  });

  it('F-1: reclaims a stale task without writing the unindexed error field (real-kernel parity)', async () => {
    // 回归：reclaimTask 曾用 updateWhere 写 error（未声明为索引）→ 真实库抛
    // `不可更新的字段：error`。强化后的 fake 也会抛，故此用例锁定整行读改写的行为。
    const fake = createFakeExtensions();
    fake.seed(
      TASK,
      {
        orderId: 'order-1',
        productId: 'prod-1',
        userId: 'user-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        quantity: 1,
        state: 'RUNNING',
        attempts: 5,
        maxAttempts: 3,
        error: null,
        payload: null,
        serviceId: null,
        nextAttemptAtMs: 0, // 已过租约
      },
      'task-stale',
    );
    bindContext(makeCtx(fake, makeProvider().provider));

    await processDue();

    const task = fake.all(TASK).find((row) => row.name === 'task-stale')!;
    expect(task.spec.state).toBe('FAILED');
    expect(task.spec.error).toBe('运行超时，已回收');
  });

  it('F-2: does not clobber a concurrently-modified task (optimistic lock)', async () => {
    // 回归：reclaimTask 的整行读改写必须带 expectedVersion；否则读与写之间若该行被并发
    // 修改（此处模拟：get 返回陈旧版本），会用陈旧快照覆盖。
    const fake = createFakeExtensions();
    fake.seed(
      TASK,
      {
        orderId: 'order-1',
        productId: 'prod-1',
        userId: 'user-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: null,
        quantity: 1,
        state: 'RUNNING',
        attempts: 5,
        maxAttempts: 3,
        error: null,
        payload: null,
        serviceId: null,
        nextAttemptAtMs: 0, // 已过租约
      },
      'task-race',
    );
    bindContext(makeCtx(fake, makeProvider().provider));

    // 模拟「读到之后、写入之前」被并发改动：get 对 task-race 返回陈旧版本。
    const stored = fake.all(TASK)[0]!;
    stored.version = 2;
    const originalGet = fake.client.get.bind(fake.client);
    fake.client.get = (async (model: CustomModelDefinition, name: string) => {
      const row = await originalGet(model, name);
      return row && name === 'task-race' ? { ...row, version: 1 } : row;
    }) as typeof fake.client.get;

    await processDue();

    // 版本冲突 → 放弃回收，不得把该行覆盖为 FAILED。
    const task = fake.all(TASK).find((row) => row.name === 'task-race')!;
    expect(task.spec.state).toBe('RUNNING');
  });

  it('lists only the current user services', async () => {
    const fake = createFakeExtensions();
    fake.seed(SERVICE, { userId: 'user-1', productName: 'A', state: 'ACTIVE' }, 'svc-1');
    fake.seed(SERVICE, { userId: 'user-2', productName: 'B', state: 'ACTIVE' }, 'svc-2');
    const { provider } = makeProvider();
    bindContext(makeCtx(fake, provider));

    const result = (await listMyServices({ user: { id: 'user-1', role: 'USER' } } as never)) as {
      services: unknown[];
    };
    expect(result.services).toHaveLength(1);
  });

  it('binds an upstream service once and rejects a second bind globally', async () => {
    const fake = createFakeExtensions();
    const { provider } = makeProvider();
    bindContext(makeCtx(fake, provider));

    const created = await storeOperations.bindService({
      userId: 'user-1',
      productId: 'up-prod-1',
      productName: '云服务器',
      fulfillmentType: 'upstream_service',
      providerId: 'zjmf',
      providerServiceId: 'svc-x',
      status: 'active',
      amount: 9900,
      currency: 'CNY',
      runtime: { upstreamId: 'up-1', host: 'node-1' },
    });
    expect(created.userId).toBe('user-1');
    expect(created.providerId).toBe('zjmf');
    expect(created.providerServiceId).toBe('svc-x');
    expect(created.status).toBe('ACTIVE');

    // 同账号重复绑定
    await expect(
      storeOperations.bindService({
        userId: 'user-1',
        productId: 'up-prod-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'svc-x',
        status: 'ACTIVE',
        amount: 9900,
        currency: 'CNY',
      }),
    ).rejects.toMatchObject({ name: 'CommerceError', failure: 'service_already_bound' });

    // 跨账号重复绑定同样被拒绝（上游服务全局唯一）
    await expect(
      storeOperations.bindService({
        userId: 'user-2',
        productId: 'up-prod-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'svc-x',
        status: 'ACTIVE',
        amount: 9900,
        currency: 'CNY',
      }),
    ).rejects.toBeInstanceOf(CommerceError);

    const bound = await storeOperations.listBoundServices('zjmf');
    expect(bound).toHaveLength(1);
    expect(bound[0]!.providerServiceId).toBe('svc-x');
  });

  it('defaults a missing provider statusLabel to null in the service detail', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'up-1',
        runtime: null,
        credentialsRef: null,
        orderId: null,
        productId: 'prod-1',
        state: 'ACTIVE',
        amount: 9900,
        currency: 'CNY',
        provisionedAt: null,
        expiresAt: null,
        terminatedAt: null,
      },
      'svc-detail-1',
    );
    const provider = {
      id: 'zjmf',
      name: '智简魔方',
      fulfillmentTypes: ['upstream_service'],
      getDetail: vi.fn(async () => ({ title: '云服务器', status: 'ACTIVE', fields: [] })),
    } as unknown as FulfillmentProvider;
    bindContext(makeCtx(fake, provider));

    const result = (await getMyService({
      params: { id: 'svc-detail-1' },
      user: { id: 'user-1', role: 'USER' },
    } as never)) as { service: { status: string; statusLabel: unknown } };

    // 提供方未返回 statusLabel 时必须是 null，而非 undefined（否则 JSON 丢字段、前端校验失败）。
    expect('statusLabel' in result.service).toBe(true);
    expect(result.service.statusLabel).toBeNull();
    expect(result.service.status).toBe('ACTIVE');
  });

  it('forwards action params to the provider and merges the returned runtime', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'up-1',
        runtime: { powerState: 'running' },
        credentialsRef: null,
        orderId: null,
        productId: 'prod-1',
        state: 'ACTIVE',
        amount: 9900,
        currency: 'CNY',
      },
      'svc-act-1',
    );
    const executeAction = vi.fn(async () => ({
      message: '系统重装已提交',
      runtime: { powerState: 'running', os: 'ubuntu-22.04' },
    }));
    const provider = {
      id: 'zjmf',
      name: '智简魔方',
      fulfillmentTypes: ['upstream_service'],
      executeAction,
    } as unknown as FulfillmentProvider;
    bindContext(makeCtx(fake, provider));

    const result = (await runMyServiceAction({
      params: { id: 'svc-act-1' },
      body: { actionId: 'reinstall', os: 'ubuntu-22.04' },
      user: { id: 'user-1', role: 'USER' },
    } as never)) as { ok: boolean; result: { message: string } | null };

    expect(executeAction).toHaveBeenCalledWith(
      'reinstall',
      expect.objectContaining({ service: expect.objectContaining({ id: 'svc-act-1' }) }),
      { os: 'ubuntu-22.04' },
    );
    expect(result.result?.message).toBe('系统重装已提交');
    // runtime 补丁应合并回服务实例
    expect(fake.all(SERVICE)[0]!.spec.runtime).toMatchObject({
      powerState: 'running',
      os: 'ubuntu-22.04',
    });
  });

  it('rejects an action for a service owned by another user', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      SERVICE,
      { userId: 'other', productName: 'A', fulfillmentType: 'upstream_service', state: 'ACTIVE' },
      'svc-other',
    );
    const { provider } = makeProvider();
    bindContext(makeCtx(fake, provider));
    await expect(
      runMyServiceAction({
        params: { id: 'svc-other' },
        body: { actionId: 'reboot' },
        user: { id: 'user-1', role: 'USER' },
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects reserved or malformed action params instead of forwarding them', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'up-1',
        runtime: null,
        credentialsRef: null,
        orderId: null,
        productId: 'prod-1',
        state: 'ACTIVE',
        amount: 9900,
        currency: 'CNY',
      },
      'svc-act-bad',
    );
    const executeAction = vi.fn(async () => undefined);
    const provider = {
      id: 'zjmf',
      name: '智简魔方',
      fulfillmentTypes: ['upstream_service'],
      executeAction,
      getDetail: async () => ({
        fields: [],
        actions: [
          {
            id: 'reinstall',
            label: '重装系统',
            params: [{ name: 'os', label: '操作系统', type: 'select' as const, required: true }],
          },
        ],
      }),
    } as unknown as FulfillmentProvider;
    bindContext(makeCtx(fake, provider));

    // 非法参数名（含空格）直接拒绝。
    await expect(
      runMyServiceAction({
        params: { id: 'svc-act-bad' },
        body: { actionId: 'reinstall', 'bad name': 'x' },
        user: { id: 'user-1', role: 'USER' },
      } as never),
    ).rejects.toMatchObject({ status: 400 });
    // 未在动作声明中的参数名（含疑似上游保留键 func）被拒绝。
    await expect(
      runMyServiceAction({
        params: { id: 'svc-act-bad' },
        body: { actionId: 'reinstall', func: 'terminate' },
        user: { id: 'user-1', role: 'USER' },
      } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(executeAction).not.toHaveBeenCalled();
    // 声明中的参数正常透传。
    await runMyServiceAction({
      params: { id: 'svc-act-bad' },
      body: { actionId: 'reinstall', os: 'debian-12' },
      user: { id: 'user-1', role: 'USER' },
    } as never);
    expect(executeAction).toHaveBeenCalledWith('reinstall', expect.anything(), { os: 'debian-12' });
  });

  it('accepts extra action params via the JSON params bag', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        productName: '云服务器',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'up-1',
        runtime: null,
        credentialsRef: null,
        orderId: null,
        productId: 'prod-1',
        state: 'ACTIVE',
        amount: 9900,
        currency: 'CNY',
      },
      'svc-act-bag',
    );
    const executeAction = vi.fn(async () => undefined);
    const provider = {
      id: 'zjmf',
      name: '智简魔方',
      fulfillmentTypes: ['upstream_service'],
      executeAction,
      getDetail: async () => ({
        fields: [],
        actions: [
          {
            id: 'reinstall',
            label: '重装系统',
            params: [
              { name: 'os', label: '系统', type: 'text' as const, required: true },
              { name: 'image_id', label: '镜像', type: 'text' as const },
            ],
          },
        ],
      }),
    } as unknown as FulfillmentProvider;
    bindContext(makeCtx(fake, provider));

    await runMyServiceAction({
      params: { id: 'svc-act-bag' },
      body: { actionId: 'reinstall', os: 'custom', params: JSON.stringify({ image_id: 'img-7' }) },
      user: { id: 'user-1', role: 'USER' },
    } as never);

    expect(executeAction).toHaveBeenCalledWith('reinstall', expect.anything(), {
      os: 'custom',
      image_id: 'img-7',
    });
  });

  it('sets an initial expiry from the checkout cycle when provisioning', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: { items: [{ productId: 'prod-cycle', quantity: 1, config: { cycle: 'monthly' } }] },
        total: 9900,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 9900,
        fxRate: null,
      },
      'order-cycle',
    );
    fake.seed(
      PRODUCT,
      {
        name: '云服务器',
        price: 9900,
        currency: 'CNY',
        status: 'ACTIVE',
        stock: 10,
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerProductId: 'up-prod-1',
        metadata: {
          checkoutConfig: {
            cycles: [{ id: 'monthly', label: '月付', price: 9900, months: 1 }],
            options: [],
          },
        },
        discount: null,
      },
      'prod-cycle',
    );
    const { provider } = makeProvider();
    bindContext(makeCtx(fake, provider));

    await enqueueOrderFulfillment('order-cycle');

    const service = fake.all(SERVICE)[0]!;
    expect(typeof service.spec.expiresAt).toBe('string');
    expect(service.spec.expiresAtMs).toBe(new Date(service.spec.expiresAt as string).getTime());
    const expected = new Date();
    expected.setMonth(expected.getMonth() + 1);
    // 允许数秒误差
    expect(Math.abs((service.spec.expiresAtMs as number) - expected.getTime())).toBeLessThan(
      10_000,
    );
  });

  it('sets an initial expiry from the product billingCycle when no checkout cycles exist', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: { items: [{ productId: 'prod-billing', quantity: 1 }] },
        total: 9900,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 9900,
        fxRate: null,
      },
      'order-billing',
    );
    fake.seed(
      PRODUCT,
      {
        name: '云服务器',
        price: 9900,
        currency: 'CNY',
        status: 'ACTIVE',
        stock: 10,
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerProductId: 'up-prod-1',
        metadata: { region: 'east-china', billingCycle: 'yearly' },
        discount: null,
      },
      'prod-billing',
    );
    const { provider } = makeProvider();
    bindContext(makeCtx(fake, provider));

    await enqueueOrderFulfillment('order-billing');

    const service = fake.all(SERVICE)[0]!;
    const expected = new Date();
    expected.setFullYear(expected.getFullYear() + 1);
    expect(Math.abs((service.spec.expiresAtMs as number) - expected.getTime())).toBeLessThan(
      10_000,
    );
  });

  it('does not mark a change applied when the provider hook throws (C-3)', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        orderId: 'order-old',
        productId: 'prod-old',
        productName: '旧配置',
        fulfillmentType: 'upstream_service',
        providerId: 'zjmf',
        providerServiceId: 'svc-up-1',
        state: 'ACTIVE',
        credentialsRef: null,
        runtime: { config: { plan: 'small' } },
        amount: 5000,
        currency: 'CNY',
        expiresAt: null,
        expiresAtMs: null,
        expiryStage: null,
        provisionedAt: null,
        terminatedAt: null,
      },
      'svc-change',
    );
    fake.seed(
      ORDER,
      {
        userId: 'user-1',
        items: {
          items: [
            {
              productId: 'prod-old',
              quantity: 1,
              changeServiceId: 'svc-change',
              changeType: 'package',
              changeSelection: { plan: 'large' },
            },
          ],
        },
        total: 1000,
        currency: 'CNY',
        state: 'PAID',
        channelCode: null,
        settlementCurrency: 'CNY',
        settlementTotal: 1000,
        fxRate: null,
      },
      'order-change',
    );
    // 提供方声明 changePackage 但抛错：变更失败必须可重试，不能标记 changeApplied。
    const changePackage = vi.fn(async () => {
      throw new Error('upstream change failed');
    });
    const provider = {
      id: 'zjmf',
      name: '智简魔方',
      fulfillmentTypes: ['upstream_service'],
      changePackage,
    } as unknown as FulfillmentProvider;
    bindContext(makeCtx(fake, provider));

    await applyChangeOrder('order-change');

    const raw = fake.all(ORDER)[0]!.spec.items as { items: Array<Record<string, unknown>> };
    expect(raw.items[0]!['changeApplied']).not.toBe(true);
    // 本地服务未被改写成目标配置。
    const service = fake.all(SERVICE)[0]!;
    expect((service.spec.runtime as { config?: { plan?: string } }).config?.plan).toBe('small');
  });
});
