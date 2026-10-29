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
  approveAdminDeliveryTask,
  reconcileProvisioning,
  reconcileAdminDeliveryTask,
  listAdminDeliveryTasks,
  retryUnconfirmedProvisioning,
  resumeAdminDeliveryPayment,
  recoverAdminDeliveryTask,
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
  'store/delivery-task': new Set(['state', 'orderId', 'userId', 'nextAttemptAtMs', 'attempts', 'exhaustedNotifiedAt']),
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
      if (table(model.kind).has(name)) throw new Error('extension.unique_violation');
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
  capture?: { warnings: string[]; adminNotices: Array<Record<string, unknown>> },
): PluginContext {
  const secrets = {
    isAvailable: () => true,
    get: async (key: string) =>
      key === 'store-provisioning-policy'
        ? JSON.stringify({ provisioningMode: 'automatic' })
        : null,
    set: async () => {},
    remove: async () => {},
  };
  return {
    manifest: { id: 'store', name: '商店插件', version: '0.3.0' },
    logger: {
      info: () => {},
      warn: (message: string) => void capture?.warnings.push(message),
      error: () => {},
    },
    events: {
      publish: () => {},
      subscribe: () => () => {},
      intercept: () => () => {},
      waterfall: <T>(_topic: string, value: T, _terminal: (value: T) => T): T => value,
    },
    extensions: fake.client,
    tx: (async (fn: (tx: unknown) => Promise<unknown>) => fn({ extensions: fake.client })) as never,
    secrets,
    payments: {} as never,
    wallet: {} as never,
    fx: {} as never,
    currency: {} as never,
    auth: {} as never,
    notifications: {
      create: async () => ({}) as never,
      upsert: async () => ({}) as never,
      notifyPermissionHolders: async (_permission: string, notice: Record<string, unknown>) => {
        capture?.adminNotices.push(notice);
        return 1;
      },
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
  it('queues verified recovery for manual approval exactly once without provisioning', async () => {
    const { fake, provision } = seedReview();
    const task = fake.all(TASK)[0]!;
    task.spec.payload = { metadata: null, providerProductId: '4661' };
    fake.seed(PRODUCT, { name: 'Cloud', price: 100, currency: 'CNY', fulfillmentType: 'upstream_service', providerId: 'zjmf', providerProductId: '4661', metadata: null }, 'product');
    const { provider } = makeProvider();
    provider.verifyCancelledProvision = vi.fn(async () => ({ sourceId: 'upstream', checkedAt: new Date().toISOString(), requests: [{ reference: 'original', invoiceId: '7001', serviceIds: ['42'] }] }));
    bindContext(makeCtx(fake, provider));
    const request = { params: { id: 'review' }, body: { confirmed: true }, user: { id: 'admin' } } as never;
    await recoverAdminDeliveryTask(request);
    expect(task.spec.state).toBe('AWAITING_APPROVAL');
    expect(task.spec.attempts).toBe(3);
    expect(task.spec.payload).toMatchObject({ recoveryGeneration: 1, resumePayment: false });
    expect(fake.all(SERVICE)[0]!.spec.state).toBe('AWAITING_APPROVAL');
    await expect(recoverAdminDeliveryTask(request)).rejects.toThrow();
    expect(provision).not.toHaveBeenCalled();
  });

  it('keeps recovery blocked when provider financial verification fails', async () => {
    const { fake, provision } = seedReview();
    fake.all(TASK)[0]!.spec.payload = { metadata: null, providerProductId: '4661' };
    fake.seed(PRODUCT, { name: 'Cloud', price: 100, currency: 'CNY', fulfillmentType: 'upstream_service', providerId: 'zjmf', providerProductId: '4661', metadata: null }, 'product');
    const { provider } = makeProvider();
    provider.verifyCancelledProvision = async () => { throw new Error('missing original invoice'); };
    bindContext(makeCtx(fake, provider));
    await expect(recoverAdminDeliveryTask({ params: { id: 'review' }, body: { confirmed: true } } as never)).rejects.toThrow('missing original invoice');
    expect(fake.all(TASK)[0]!.spec.state).toBe('REQUIRES_RECONCILIATION');
    expect(provision).not.toHaveBeenCalled();
  });
  it.each(['refunded', 'stale', 'missing-request', 'changed-task'])('rejects unsafe recovery after verification: %s', async scenario => {
    const { fake } = seedReview();
    const task = fake.all(TASK)[0]!;
    task.spec.payload = { metadata: null, providerProductId: '4661' };
    fake.seed(PRODUCT, { name: 'Cloud', price: 100, currency: 'CNY', fulfillmentType: 'upstream_service', providerId: 'zjmf', providerProductId: '4661', metadata: null }, 'product');
    const { provider, provision } = makeProvider();
    provider.verifyCancelledProvision = async () => {
      if (scenario === 'refunded') fake.all(ORDER)[0]!.spec.state = 'REFUNDED';
      if (scenario === 'changed-task') task.version++;
      return { sourceId: 'upstream', checkedAt: new Date(Date.now() - (scenario === 'stale' ? 120_000 : 0)).toISOString(), requests: scenario === 'missing-request' ? [] : [{ reference: 'original', invoiceId: '7001', serviceIds: ['42'] }] };
    };
    bindContext(makeCtx(fake, provider));
    await expect(recoverAdminDeliveryTask({ params: { id: 'review' }, body: { confirmed: true } } as never)).rejects.toThrow();
    expect(task.spec.state).toBe('REQUIRES_RECONCILIATION');
    expect(provision).not.toHaveBeenCalled();
  });
  it('fulfills every purchased unit once across repeated and concurrent payment events', async () => {
    const fake = createFakeExtensions();
    fake.seed(ORDER, { userId: 'user', state: 'PAID', items: { items: [{ productId: 'product', quantity: 3 }] } }, 'multi');
    fake.seed(PRODUCT, { name: 'Cloud', price: 100, currency: 'CNY', fulfillmentType: 'upstream_service', providerId: 'zjmf', metadata: null }, 'product');
    const { provider, provision } = makeProvider();
    provision.mockImplementation(async (ctx: never) => ({ status: 'PENDING', providerServiceId: (ctx as { fulfillmentId: string }).fulfillmentId, runtime: { paid: true } }) as never);
    bindContext(makeCtx(fake, provider));
    await Promise.all([enqueueOrderFulfillment('multi'), enqueueOrderFulfillment('multi')]);
    await enqueueOrderFulfillment('multi');
    expect(fake.all(TASK)).toHaveLength(3);
    expect(fake.all(SERVICE)).toHaveLength(3);
    expect(provision).toHaveBeenCalledTimes(3);
    expect(provision.mock.calls.every(args => (args as unknown as [{ quantity: number }])[0].quantity === 1)).toBe(true);
    expect(new Set(fake.all(SERVICE).map(row => row.spec.providerServiceId)).size).toBe(3);
  });

  it('never expands an existing legacy batch into new upstream requests', async () => {
    const { fake, provision } = seedReview();
    fake.all(TASK)[0]!.spec.quantity = 2;
    fake.all(ORDER)[0]!.spec.items = { items: [{ productId: 'product', quantity: 2 }] };
    fake.seed(PRODUCT, { name: 'Cloud', price: 100, currency: 'CNY', fulfillmentType: 'upstream_service', providerId: 'zjmf', metadata: null }, 'product');
    await enqueueOrderFulfillment('paid');
    expect(fake.all(TASK)).toHaveLength(1);
    expect(provision).not.toHaveBeenCalled();
  });

  it('reads unresolved-payment service state without inventing payment or activation time', async () => {
    const { fake, provision } = seedReview();
    const row = fake.all(SERVICE)[0]!;
    Object.assign(row.spec, { state: 'AWAITING_UPSTREAM_PAYMENT', providerServiceId: 'remote', runtime: { paid: false, paymentState: 'PAYMENT_UNKNOWN', invoiceId: 'bill' } });
    const { provider } = makeProvider();
    provider.getDetail = async () => ({ status: 'ACTIVE', fields: [], provisionedAt: '2026-10-21T08:12:34Z', expiresAt: '2026-11-21T08:12:34Z' });
    bindContext(makeCtx(fake, provider));
    await reconcileProvisioning();
    expect(row.spec.state).toBe('ACTIVE');
    expect(row.spec.provisionedAt).toBe('2026-10-21T08:12:34.000Z');
    expect(row.spec.expiresAt).toBe('2026-11-21T08:12:34.000Z');
    expect(row.spec.expiresAtMs).toBe(Date.parse('2026-11-21T08:12:34Z'));
    expect(row.spec.runtime).toMatchObject({ paid: false, paymentState: 'PAYMENT_UNKNOWN' });
    expect(fake.all(TASK)[0]!.spec.state).toBe('REQUIRES_RECONCILIATION');
    expect(provision).not.toHaveBeenCalled();
  });

  function seedReview() {
    const fake = createFakeExtensions();
    fake.seed(ORDER, { userId: 'user', state: 'PAID' }, 'paid');
    fake.seed(TASK, { orderId: 'paid', productId: 'product', userId: 'user', productName: 'Cloud', fulfillmentType: 'cloud_server', providerId: 'zjmf', quantity: 1, state: 'REQUIRES_RECONCILIATION', attempts: 3, maxAttempts: 3, error: 'secret-provider-error', payload: {}, serviceId: null, nextAttemptAtMs: 0 }, 'review');
    fake.seed(SERVICE, { userId: 'user', orderId: 'paid', productId: 'product', providerId: 'zjmf', providerServiceId: null, productName: 'Cloud', fulfillmentType: 'cloud_server', state: 'PROVISIONING', amount: 137, currency: 'CNY', runtime: { config: { cycle: 'monthly' } } }, 'instance-review');
    const { provider, provision } = makeProvider();
    bindContext(makeCtx(fake, provider));
    return { fake, provision };
  }

  it('shows uncertain results in the admin queue and user state without leaking errors', async () => {
    seedReview();
    const queue = await listAdminDeliveryTasks({ query: { status: 'attention' } } as never) as { tasks: unknown[]; total: number };
    expect(queue.total).toBe(1);
    expect(JSON.stringify(queue)).not.toContain('secret-provider-error');
    // 尝试用尽必须自己在队列里说出来：否则这单永远停在「待核对」，无人知道该退款。
    const row = (queue as { tasks: Array<{ attempts: number; maxAttempts: number; retryExhausted: boolean; reason: string | null }> }).tasks[0]!;
    expect(row.retryExhausted).toBe(true);
    expect(row.maxAttempts).toBe(3);
    expect(row.reason).toContain('自动重试已用尽');
    const result = await getMyService({ params: { id: 'instance-review' }, user: { id: 'user' } } as never) as { service: { status: string } };
    expect(result.service.status).toBe('REQUIRES_RECONCILIATION');
  });

  it('tells operators exactly once when automatic retries run out', async () => {
    const { fake } = seedReview();
    const capture = { warnings: [] as string[], adminNotices: [] as Array<Record<string, unknown>> };
    bindContext(makeCtx(fake, makeProvider().provider, capture));

    // 用尽的单不再入队：再跑一遍还是 0，但必须留下可见的痕迹。
    const requeued = await retryUnconfirmedProvisioning(Date.parse('2026-10-30T00:00:00Z'));
    expect(requeued).toBe(0);
    expect(fake.all(TASK)[0]!.spec.state).toBe('REQUIRES_RECONCILIATION');
    expect(capture.warnings.join('\n')).toMatch(/自动重试用尽 3\/3/);
    expect(capture.adminNotices).toHaveLength(1);
    expect(capture.adminNotices[0]!['title']).toBe('订单开通自动重试用尽');
    expect(typeof fake.all(TASK)[0]!.spec.exhaustedNotifiedAt).toBe('string');

    // 排障轮询每 5 分钟一轮：第二轮不许再刷一条相同通知。
    await retryUnconfirmedProvisioning(Date.parse('2026-10-30T00:05:00Z'));
    expect(capture.adminNotices).toHaveLength(1);
    expect(capture.warnings).toHaveLength(1);
  });

  it('still requeues a task that has retry budget left', async () => {
    const { fake } = seedReview();
    const row = fake.all(TASK)[0]!;
    fake.seed(TASK, { ...row.spec, attempts: 1 }, row.name);
    const capture = { warnings: [] as string[], adminNotices: [] as Array<Record<string, unknown>> };
    bindContext(makeCtx(fake, makeProvider().provider, capture));
    expect(await retryUnconfirmedProvisioning(Date.parse('2026-10-30T00:00:00Z'))).toBe(1);
    expect(fake.all(TASK)[0]!.spec.state).toBe('PENDING');
    expect(capture.adminNotices).toHaveLength(0);
  });

  it('never lets a manual declaration replay a previously submitted request', async () => {
    const { fake, provision } = seedReview();
    const request = { params: { id: 'review' }, user: { id: 'admin' }, body: { outcome: 'not_created', confirmed: true, note: 'Verified all upstream orders' } };
    await expect(reconcileAdminDeliveryTask({ ...request, body: { ...request.body, confirmed: false } } as never)).rejects.toThrow();
    await expect(reconcileAdminDeliveryTask(request as never)).rejects.toThrow(/请求已执行过/);
    await processDue();
    expect(provision).not.toHaveBeenCalled();
    expect(fake.all(TASK)[0]?.spec.state).toBe('REQUIRES_RECONCILIATION');
    expect(fake.all(SERVICE)[0]?.spec.state).toBe('PROVISIONING');
  });

  it('keeps an exception on the last attempt uncertain rather than allowing a refund/replay', async () => {
    const { fake, provision } = seedReview();
    fake.all(TASK)[0]!.spec.state = 'PENDING';
    fake.all(TASK)[0]!.spec.attempts = 2;
    fake.seed(PRODUCT, { name: 'Cloud', price: 100, currency: 'CNY', fulfillmentType: 'cloud_server', providerId: 'zjmf', metadata: null }, 'product');
    provision.mockRejectedValue(new Error('request timed out after upstream accepted'));
    await processDue();
    expect(fake.all(TASK)[0]?.spec.state).toBe('REQUIRES_RECONCILIATION');
    expect(fake.all(SERVICE)[0]?.spec.state).toBe('PROVISIONING');
    await processDue();
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('persists an upstream identity before payment, and never reports unpaid orders as provisioned', async () => {
    const { fake, provision } = seedReview();
    fake.all(TASK)[0]!.spec.state = 'PENDING';
    fake.seed(PRODUCT, { name: 'Cloud', price: 100, currency: 'CNY', fulfillmentType: 'cloud_server', providerId: 'zjmf', metadata: null }, 'product');
    provision.mockImplementation(async (input: import('@stackpanel/sdk').ProvisionContext) => {
      await input.checkpoint?.({ status: 'PENDING', providerServiceId: 'remote', runtime: { invoiceId: 'bill', paid: false, paymentState: 'ORDER_CREATED' } });
      expect(fake.all(SERVICE)[0]?.spec).toMatchObject({ providerServiceId: 'remote', state: 'AWAITING_UPSTREAM_PAYMENT' });
      return { status: 'PENDING', providerServiceId: 'remote', runtime: { invoiceId: 'bill', paid: false, paymentState: 'PAYMENT_REQUIRED' } };
    });
    await processDue();
    expect(fake.all(TASK)[0]?.spec.state).toBe('REQUIRES_RECONCILIATION');
    expect(fake.all(SERVICE)[0]?.spec.state).toBe('AWAITING_UPSTREAM_PAYMENT');
    const queue = await listAdminDeliveryTasks({ query: { status: 'attention' } } as never) as { tasks: Array<{ canResumePayment: boolean }> };
    expect(queue.tasks[0]?.canResumePayment).toBe(true);
    const request = { params: { id: 'review' }, body: { confirmed: true } } as never;
    await resumeAdminDeliveryPayment(request);
    expect(fake.all(TASK)[0]?.spec).toMatchObject({ state: 'PENDING', payload: { resumePayment: true } });
    await expect(resumeAdminDeliveryPayment(request)).rejects.toThrow();
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('keeps the recorded upstream identity if a later step throws, blocking a second order', async () => {
    const { fake, provision } = seedReview();
    fake.all(TASK)[0]!.spec.state = 'PENDING';
    fake.seed(PRODUCT, { name: 'Cloud', price: 100, currency: 'CNY', fulfillmentType: 'cloud_server', providerId: 'zjmf', metadata: null }, 'product');
    provision.mockImplementation(async (input: import('@stackpanel/sdk').ProvisionContext) => {
      await input.checkpoint?.({ status: 'PENDING', providerServiceId: 'remote', runtime: { invoiceId: 'bill', paid: false, paymentState: 'PAYMENT_IN_FLIGHT' } });
      throw new Error('response lost');
    });
    await processDue();
    await processDue();
    expect(fake.all(SERVICE)[0]?.spec.providerServiceId).toBe('remote');
    expect(fake.all(TASK)[0]?.spec.state).toBe('REQUIRES_RECONCILIATION');
    expect(provision).toHaveBeenCalledTimes(1);
    await expect(resumeAdminDeliveryPayment({ params: { id: 'review' }, body: { confirmed: true } } as never)).rejects.toThrow(/禁止重试/);
  });

  it('blocks changed upstream mappings before calling the provider', async () => {
    const { fake, provision } = seedReview();
    fake.all(TASK)[0]!.spec.state = 'PENDING';
    fake.all(TASK)[0]!.spec.payload = { providerProductId: 'original', metadata: { upstream: { sourceRef: 'original-source' } } };
    fake.seed(PRODUCT, { name: 'Cloud', price: 100, currency: 'CNY', fulfillmentType: 'cloud_server', providerId: 'zjmf', providerProductId: 'replacement', metadata: { upstream: { sourceRef: 'replacement-source' } } }, 'product');
    await processDue();
    expect(provision).not.toHaveBeenCalled();
    expect(fake.all(TASK)[0]?.spec.state).toBe('FAILED');
  });

  it('uses the paid line price instead of current catalog price for new service records', async () => {
    const { fake, provision } = seedReview();
    fake.seed(ORDER, { userId: 'user', state: 'PAID', items: { items: [{ productId: 'discounted', quantity: 1, price: 137 }] } }, 'discount-order');
    fake.seed(PRODUCT, { name: 'Discounted', price: 5500, currency: 'CNY', fulfillmentType: 'cloud_server', providerId: 'zjmf', metadata: null }, 'discounted');
    await enqueueOrderFulfillment('discount-order');
    expect(provision).toHaveBeenCalledTimes(1);
    const service = fake.all(SERVICE).find(row => row.spec.orderId === 'discount-order');
    expect(service?.spec.amount).toBe(137);
  });

  it('links a verified imported instance atomically while keeping the original service URL', async () => {
    const { fake, provision } = seedReview();
    fake.seed(SERVICE, { ...fake.all(SERVICE)[0]!.spec, orderId: null, providerServiceId: 'remote', state: 'ACTIVE', amount: 5500, runtime: { ip: '203.0.113.1' } }, 'imported');
    await reconcileAdminDeliveryTask({ params: { id: 'review' }, body: { outcome: 'existing', serviceId: 'imported', confirmed: true, note: 'Verified upstream instance identity' } } as never);
    expect(fake.all(SERVICE)).toHaveLength(1);
    expect(fake.all(SERVICE)[0]?.name).toBe('instance-review');
    expect(fake.all(SERVICE)[0]?.spec).toMatchObject({ providerServiceId: 'remote', state: 'ACTIVE', amount: 137, orderId: 'paid' });
    expect(fake.all(TASK)[0]?.spec).toMatchObject({ state: 'SUCCEEDED', serviceId: 'instance-review' });
    await processDue();
    expect(provision).not.toHaveBeenCalled();
  });

  it('rejects refunded orders, unrelated owners, products, and upstream sources', async () => {
    for (const patch of [{ userId: 'other' }, { productId: 'other' }, { providerId: 'other' }, { orderId: 'other-order' }, { runtime: { upstreamId: 'other-source' } }]) {
      const { fake, provision } = seedReview();
      fake.all(TASK)[0]!.spec.payload = { metadata: { upstream: { sourceRef: 'source' } } };
      fake.seed(SERVICE, { ...fake.all(SERVICE)[0]!.spec, orderId: null, providerServiceId: 'remote', state: 'ACTIVE', runtime: { upstreamId: 'source' }, ...patch }, 'imported');
      await expect(reconcileAdminDeliveryTask({ params: { id: 'review' }, body: { outcome: 'existing', serviceId: 'imported', confirmed: true, note: 'Verification evidence' } } as never)).rejects.toThrow();
      expect(provision).not.toHaveBeenCalled();
      expect(fake.all(TASK)[0]?.spec.state).toBe('REQUIRES_RECONCILIATION');
    }
    const { fake } = seedReview();
    fake.all(ORDER)[0]!.spec.state = 'REFUNDED';
    await expect(reconcileAdminDeliveryTask({ params: { id: 'review' }, body: { outcome: 'not_created', confirmed: true, note: 'Verification evidence' } } as never)).rejects.toThrow();
  });
  it('deduplicates concurrent paid events and reconciles asynchronous provisioning without reordering', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      { userId: 'user', state: 'PAID', items: { items: [{ productId: 'product', quantity: 1 }] } },
      'paid',
    );
    fake.seed(
      PRODUCT,
      {
        name: 'Cloud',
        price: 100,
        currency: 'CNY',
        fulfillmentType: 'cloud_server',
        providerId: 'zjmf',
        metadata: null,
      },
      'product',
    );
    const { provider, provision } = makeProvider();
    provision.mockResolvedValue({ status: 'PENDING', providerServiceId: 'upstream-id' } as never);
    provider.getDetail = async () => ({ status: 'ACTIVE', fields: [] });
    bindContext(makeCtx(fake, provider));
    await Promise.all([enqueueOrderFulfillment('paid'), enqueueOrderFulfillment('paid')]);
    expect(fake.all(TASK)).toHaveLength(1);
    expect(fake.all(SERVICE)).toHaveLength(1);
    expect(fake.all(SERVICE)[0]?.spec.state).toBe('PROVISIONING');
    expect(provision).toHaveBeenCalledTimes(1);
    await reconcileProvisioning();
    expect(fake.all(SERVICE)[0]?.spec.state).toBe('ACTIVE');
    expect(provision).toHaveBeenCalledTimes(1);
  });
  it('holds manual orders, rejects duplicate approval, and provisions only after approval', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      ORDER,
      { userId: 'user', state: 'PAID', items: { items: [{ productId: 'product', quantity: 1 }] } },
      'paid',
    );
    fake.seed(
      PRODUCT,
      {
        name: 'Cloud',
        price: 100,
        currency: 'CNY',
        fulfillmentType: 'cloud_server',
        providerId: 'zjmf',
        metadata: null,
      },
      'product',
    );
    const { provider, provision } = makeProvider();
    const ctx = makeCtx(fake, provider);
    ctx.secrets.get = async () => JSON.stringify({ provisioningMode: 'manual' });
    bindContext(ctx);
    await enqueueOrderFulfillment('paid');
    await processDue();
    expect(provision).not.toHaveBeenCalled();
    expect(fake.all(SERVICE)[0]?.spec.state).toBe('AWAITING_APPROVAL');
    const task = fake.all(TASK)[0]!;
    const req = { params: { id: task.name }, user: { id: 'admin' } } as never;
    const results = await Promise.allSettled([
      approveAdminDeliveryTask(req),
      approveAdminDeliveryTask(req),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    provision.mockImplementation(async () => {
      expect(fake.all(SERVICE)[0]?.spec.state).toBe('PROVISIONING');
      return { status: 'ACTIVE', providerServiceId: 'approved-instance' };
    });
    await processDue();
    expect(provision).toHaveBeenCalledTimes(1);
    expect(fake.all(SERVICE)).toHaveLength(1);
    expect(fake.all(SERVICE)[0]?.spec.state).toBe('ACTIVE');
  });
  it('does not enqueue unpaid or refunded orders', async () => {
    const fake = createFakeExtensions();
    const { provider, provision } = makeProvider();
    bindContext(makeCtx(fake, provider));
    for (const state of ['PENDING', 'REFUNDED', 'CANCELLED']) {
      fake.seed(
        ORDER,
        { userId: 'user', state, items: { items: [{ productId: 'product', quantity: 1 }] } },
        state,
      );
      await enqueueOrderFulfillment(state);
    }
    expect(fake.all(TASK)).toHaveLength(0);
    expect(provision).not.toHaveBeenCalled();
  });
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

  it('does not replay an ambiguous upstream timeout', async () => {
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
    expect(task.spec.state).toBe('REQUIRES_RECONCILIATION');
    expect(task.spec.error).toBe('上游超时');
    expect(task.spec.nextAttemptAtMs).toBe(0);

    // 耗尽重试次数（attempts 达到 maxAttempts）后置为 FAILED
    await processDue();
    expect(fake.all(TASK)[0]?.spec.state).toBe('REQUIRES_RECONCILIATION');
    expect(fake.all(TASK)[0]?.spec.error).toBe('上游超时');
    expect(provision).toHaveBeenCalledTimes(1);
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
    expect(task.spec.state).toBe('REQUIRES_RECONCILIATION');
    expect(task.spec.error).toBe('开通请求超时，需核对上游结果');
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

  it('lists persisted selected specifications without substituting product defaults or leaking metadata', async () => {
    const fake = createFakeExtensions();
    fake.seed(
      PRODUCT,
      {
        name: 'Cloud',
        metadata: {
          secret: 'never-public',
          checkoutConfig: {
            cycles: [{ id: 'monthly', label: '月', price: 100 }],
            options: [
              {
                id: 'cpu',
                label: 'CPU',
                type: 'select',
                defaultChoice: 'small',
                choices: [
                  { id: 'small', label: '2核' },
                  { id: 'large', label: '4核' },
                ],
              },
              { id: 'ip', label: 'IP数量', type: 'quantity', unit: '个' },
              {
                id: 'os',
                label: '操作系统',
                type: 'select',
                choices: [{ id: 'debian', label: 'Debian13' }],
              },
            ],
          },
        },
      },
      'cloud',
    );
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        productId: 'cloud',
        productName: 'Cloud',
        state: 'PROVISIONING',
        runtime: { config: { selections: { cpu: 'large', ip: 2, os: 'removed' } } },
      },
      'svc-selected',
    );
    fake.seed(
      SERVICE,
      {
        userId: 'user-1',
        productId: 'cloud',
        productName: 'Cloud',
        state: 'PROVISIONING',
        runtime: null,
      },
      'svc-empty',
    );
    bindContext(makeCtx(fake, makeProvider().provider));
    const result = (await listMyServices({ user: { id: 'user-1', role: 'USER' } } as never)) as {
      services: Array<{ id: string; configuration: Array<{ label: string; value: string }> }>;
    };
    expect(result.services.find((service) => service.id === 'svc-selected')?.configuration).toEqual(
      [
        { label: 'CPU', value: '4核' },
        { label: 'IP数量', value: '2个' },
      ],
    );
    expect(result.services.find((service) => service.id === 'svc-empty')?.configuration).toEqual(
      [],
    );
    expect(JSON.stringify(result)).not.toContain('never-public');
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

  it('imports account-scoped instances with exact product mapping without provisioning', async () => {
    const fake = createFakeExtensions();
    const { provider, provision } = makeProvider();
    bindContext(makeCtx(fake, provider));
    fake.seed(
      PRODUCT,
      {
        name: 'Mapped',
        price: 100,
        currency: 'CNY',
        fulfillmentType: 'cloud_server',
        providerId: 'zjmf',
        providerProductId: '7',
        metadata: { upstream: { sourceRef: 'account-a' } },
      },
      'local-product',
    );
    const input = {
      userId: 'user-1',
      productId: 'remote-placeholder',
      productName: 'Existing',
      fulfillmentType: 'upstream_service',
      providerId: 'zjmf',
      providerServiceId: '42',
      status: 'ACTIVE',
      amount: 100,
      currency: 'CNY',
      runtime: { upstreamId: 'account-a', upstreamProductId: '7' },
    };
    const imported = await storeOperations.bindService(input);
    expect(imported.productId).toBe('local-product');
    expect(imported.fulfillmentType).toBe('cloud_server');
    await storeOperations.bindService({
      ...input,
      userId: 'user-2',
      runtime: { upstreamId: 'account-b', upstreamProductId: '7' },
    });
    expect(fake.all(SERVICE)).toHaveLength(2);
    expect(provision).not.toHaveBeenCalled();
    expect(fake.all(TASK)).toHaveLength(0);
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
