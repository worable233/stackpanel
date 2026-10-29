import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CustomModelDefinition,
  ExtensionClient,
  ExtensionInstance,
  PluginContext,
} from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';

/**
 * 实例页退款：申请即停用、驳回即恢复、通过后停服。
 *
 * 这些路径都在动真钱和真机器，所以每条断言都盯着两件事：客户看到的状态，
 * 和上游到底有没有被叫到（`suspend`/`resume`/`terminate` 的调用次数与顺序）。
 */

vi.mock('./settings', () => ({ refundPolicy: vi.fn(), storeSettings: vi.fn() }));
vi.mock('./fulfillment', () => ({ providerForProduct: vi.fn() }));

// 静态 import：vi.mock 会被提升到它之前，避免与其它测试文件共享模块缓存时
// mock 偶发失效。
import { refundPolicy } from './settings';
import { providerForProduct } from './fulfillment';
import {
  createServiceRefundRequest,
  getServiceRefundEligibility,
  reviewRefundRequest,
} from './refund';
import { DEFAULT_REFUND_POLICY } from './refund-policy';

const DAY = 86_400_000;
const FIXED_NOW = new Date('2026-01-15T00:00:00.000Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

type Stored = {
  name: string;
  spec: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function createFakeExtensions() {
  const tables = new Map<string, Map<string, Stored>>();
  let seq = 0;
  const table = (kind: string): Map<string, Stored> => {
    let existing = tables.get(kind);
    if (!existing) {
      existing = new Map<string, Stored>();
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
        publish: () => {},
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
const SERVICE = 'store/service-instance';
const PRODUCT = 'store/product';
const REQUEST = 'store/refund-request';

function seedScenario(
  fake: ReturnType<typeof createFakeExtensions>,
  opts: {
    serviceState?: string;
    windowDays?: number | null;
    amountMode?: 'full' | 'prorated';
    provisionedDaysAgo?: number;
    periodDays?: number;
    policyEnabled?: boolean;
  } = {},
) {
  const now = Date.now();
  const provisionedDaysAgo = opts.provisionedDaysAgo ?? 1;
  const periodDays = opts.periodDays ?? 30;
  fake.seed(
    PRODUCT,
    { name: '香港EPYC-4H8G', stock: 5, status: 'ACTIVE', providerId: 'zjmf-upstream' },
    'prod-1',
  );
  fake.seed(
    ORDER,
    {
      userId: 'user-1',
      items: { items: [{ productId: 'prod-1', quantity: 1 }] },
      total: 7200,
      currency: 'CNY',
      state: 'PAID',
      channelCode: null,
      settlementCurrency: 'CNY',
      settlementTotal: 7200,
      fxRate: null,
    },
    'order-1',
  );
  fake.seed(
    SERVICE,
    {
      userId: 'user-1',
      orderId: 'order-1',
      productId: 'prod-1',
      productName: '香港EPYC-4H8G',
      fulfillmentType: 'cloud-server',
      providerId: 'zjmf-upstream',
      providerServiceId: '33363',
      state: opts.serviceState ?? 'ACTIVE',
      credentialsRef: null,
      runtime: null,
      amount: 7200,
      currency: 'CNY',
      expiresAt: new Date(now + (periodDays - provisionedDaysAgo) * DAY).toISOString(),
      expiresAtMs: now + (periodDays - provisionedDaysAgo) * DAY,
      expiryStage: null,
      expiryAttempts: 0,
      expiryLastError: null,
      provisionedAt: new Date(now - provisionedDaysAgo * DAY).toISOString(),
      terminatedAt: null,
    },
    'svc-1',
  );
  vi.mocked(refundPolicy).mockResolvedValue({
    ...DEFAULT_REFUND_POLICY,
    enabled: opts.policyEnabled ?? true,
    windowDays: opts.windowDays === undefined ? 7 : opts.windowDays,
    amountMode: opts.amountMode ?? 'prorated',
    suspendOnRequest: true,
    terminateOnApprove: true,
    oncePerOrder: true,
  });
}

const provider = () => ({
  suspend: vi.fn(async () => {}),
  resume: vi.fn(async () => {}),
  terminate: vi.fn(async () => {}),
});

const USER = { id: 'user-1', role: 'USER' } as never;
const ADMIN = { id: 'admin-1', role: 'ADMIN' } as never;

describe('实例页退款资格', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    resetContext();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('政策关闭时不给入口', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake, { policyEnabled: false });
    bindContext(makeCtx(fake, vi.fn()));
    const result = (await getServiceRefundEligibility({
      params: { id: 'svc-1' },
      user: USER,
    } as never)) as {
      eligible: boolean;
      reason: string;
    };
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('暂未开放');
  });

  it('窗口内按未使用时长给出可退金额', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake, { provisionedDaysAgo: 1, periodDays: 30 });
    bindContext(makeCtx(fake, vi.fn()));
    const result = (await getServiceRefundEligibility({
      params: { id: 'svc-1' },
      user: USER,
    } as never)) as {
      eligible: boolean;
      refundableAmount: number;
      currency: string;
      windowEndsAt: string | null;
    };
    expect(result.eligible).toBe(true);
    // 月付 ¥72.00 用掉 1 天 → 退 29/30 ≈ ¥69.60
    expect(result.refundableAmount).toBe(6960);
    expect(result.currency).toBe('CNY');
    expect(result.windowEndsAt).not.toBeNull();
  });

  it('超过时间窗口后拒绝', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake, { provisionedDaysAgo: 10, windowDays: 7 });
    bindContext(makeCtx(fake, vi.fn()));
    const result = (await getServiceRefundEligibility({
      params: { id: 'svc-1' },
      user: USER,
    } as never)) as {
      eligible: boolean;
      reason: string;
    };
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('时间窗口');
  });

  it('永久窗口（null）不因时间拒绝', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake, { provisionedDaysAgo: 200, windowDays: null, periodDays: 30 });
    bindContext(makeCtx(fake, vi.fn()));
    const result = (await getServiceRefundEligibility({
      params: { id: 'svc-1' },
      user: USER,
    } as never)) as {
      eligible: boolean;
      reason: string | null;
      windowEndsAt: string | null;
    };
    expect(result.windowEndsAt).toBeNull();
    // 服务早已到期 → 按比例可退 0，仍然会被金额规则挡住（这是对的）
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('可退金额为 0');
  });

  it('别人的服务看不到资格', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake);
    bindContext(makeCtx(fake, vi.fn()));
    await expect(
      getServiceRefundEligibility({
        params: { id: 'svc-1' },
        user: { id: 'user-2', role: 'USER' },
      } as never),
    ).rejects.toThrow('服务不存在');
  });
});

describe('实例页提交退款申请', () => {
  beforeEach(() => {
    resetContext();
    vi.clearAllMocks();
  });

  it('先停用实例再落申请，金额由政策决定', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake, { provisionedDaysAgo: 1, periodDays: 30 });
    const p = provider();
    vi.mocked(providerForProduct).mockReturnValue(p as never);
    bindContext(makeCtx(fake, vi.fn()));
    const created = (await createServiceRefundRequest({
      params: { id: 'svc-1' },
      body: { reason: '不想用了' },
      user: USER,
    } as never)) as { request: { amount: number; status: string }; serviceSuspended: boolean };
    expect(p.suspend).toHaveBeenCalledTimes(1);
    expect(created.serviceSuspended).toBe(true);
    expect(created.request.amount).toBe(6960);
    expect(created.request.status).toBe('PENDING');
    // 实例已被停用（可逆）
    expect(fake.all(SERVICE)[0]!.spec.state).toBe('SUSPENDED');
    // 申请里记下服务 id 与停用事实，驳回时才能恢复
    const request = fake.all(REQUEST)[0]!;
    expect(request.spec.serviceId).toBe('svc-1');
    expect(request.spec.suspendApplied).toBe(true);
  });

  it('客户端不能自己定价（金额只来自政策）', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake, { provisionedDaysAgo: 1, periodDays: 30 });
    vi.mocked(providerForProduct).mockReturnValue(provider() as never);
    bindContext(makeCtx(fake, vi.fn()));
    const created = (await createServiceRefundRequest({
      params: { id: 'svc-1' },
      body: { amount: 7200 },
      user: USER,
    } as never)) as { request: { amount: number } };
    expect(created.request.amount).toBe(6960);
  });

  it('停用失败就不建申请（不能承诺已经停用）', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake);
    const p = provider();
    p.suspend.mockRejectedValueOnce(new Error('上游超时'));
    vi.mocked(providerForProduct).mockReturnValue(p as never);
    bindContext(makeCtx(fake, vi.fn()));
    await expect(
      createServiceRefundRequest({ params: { id: 'svc-1' }, body: {}, user: USER } as never),
    ).rejects.toThrow('实例停用失败');
    expect(fake.all(REQUEST)).toHaveLength(0);
    expect(fake.all(SERVICE)[0]!.spec.state).toBe('ACTIVE');
  });

  it('已有在途申请时不允许重复提交', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake, { serviceState: 'SUSPENDED', provisionedDaysAgo: 1, periodDays: 30 });
    fake.seed(
      REQUEST,
      {
        orderId: 'order-1',
        userId: 'user-1',
        amount: 6960,
        currency: 'CNY',
        reason: null,
        state: 'PENDING',
        reviewerId: null,
        reviewReason: null,
        failureReason: null,
        destination: 'WALLET',
        idempotencyKey: null,
        serviceId: 'svc-1',
        suspendApplied: true,
        terminateApplied: false,
        terminateError: null,
      },
      'req-existing',
    );
    bindContext(makeCtx(fake, vi.fn()));
    await expect(
      createServiceRefundRequest({ params: { id: 'svc-1' }, body: {}, user: USER } as never),
    ).rejects.toThrow('已提交过退款申请');
  });
});

describe('实例页退款审核', () => {
  beforeEach(() => {
    resetContext();
    vi.clearAllMocks();
  });

  function seedPendingRequest(fake: ReturnType<typeof createFakeExtensions>): void {
    fake.seed(
      REQUEST,
      {
        orderId: 'order-1',
        userId: 'user-1',
        amount: 6960,
        currency: 'CNY',
        reason: '不想用了',
        state: 'PENDING',
        reviewerId: null,
        reviewReason: null,
        failureReason: null,
        destination: 'WALLET',
        idempotencyKey: null,
        serviceId: 'svc-1',
        suspendApplied: true,
        terminateApplied: false,
        terminateError: null,
      },
      'req-1',
    );
  }

  it('驳回后自动恢复实例', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake, { serviceState: 'SUSPENDED' });
    seedPendingRequest(fake);
    const p = provider();
    vi.mocked(providerForProduct).mockReturnValue(p as never);
    bindContext(makeCtx(fake, vi.fn()));
    const result = (await reviewRefundRequest({
      params: { id: 'req-1' },
      body: { decision: 'reject', reason: '不符合退款条件' },
      user: ADMIN,
    } as never)) as { request: { status: string } };
    expect(result.request.status).toBe('REJECTED');
    expect(p.resume).toHaveBeenCalledTimes(1);
    expect(p.terminate).not.toHaveBeenCalled();
    expect(fake.all(SERVICE)[0]!.spec.state).toBe('ACTIVE');
    expect(fake.all(ORDER)[0]!.spec.state).toBe('PAID');
  });

  it('通过后退余额并向上游提交停用申请', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake, { serviceState: 'SUSPENDED' });
    seedPendingRequest(fake);
    const p = provider();
    vi.mocked(providerForProduct).mockReturnValue(p as never);
    const credit = vi.fn(async () => ({}));
    bindContext(makeCtx(fake, credit));
    const result = (await reviewRefundRequest({
      params: { id: 'req-1' },
      body: { decision: 'approve' },
      user: ADMIN,
    } as never)) as { request: { status: string } };
    expect(result.request.status).toBe('SUCCEEDED');
    expect(credit).toHaveBeenCalledWith(
      'user-1',
      6960,
      'CNY',
      expect.objectContaining({ type: 'ORDER_REFUND' }),
    );
    expect(p.terminate).toHaveBeenCalledTimes(1);
    expect(p.resume).not.toHaveBeenCalled();
    expect(fake.all(SERVICE)[0]!.spec.state).toBe('TERMINATED');
    const request = fake.all(REQUEST)[0]!;
    expect(request.spec.state).toBe('SUCCEEDED');
    expect(request.spec.terminateApplied).toBe(true);
    expect(request.spec.terminateError).toBeNull();
  });

  it('停服失败不改退款结论，只留痕', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake, { serviceState: 'SUSPENDED' });
    seedPendingRequest(fake);
    const p = provider();
    p.terminate.mockRejectedValueOnce(new Error('上游 406 取消类型错误'));
    vi.mocked(providerForProduct).mockReturnValue(p as never);
    const credit = vi.fn(async () => ({}));
    bindContext(makeCtx(fake, credit));
    const result = (await reviewRefundRequest({
      params: { id: 'req-1' },
      body: { decision: 'approve' },
      user: ADMIN,
    } as never)) as { request: { status: string } };
    // 钱已经退了，就不该把结论改成失败（那会诱导运营重复退款）
    expect(result.request.status).toBe('SUCCEEDED');
    expect(credit).toHaveBeenCalledTimes(1);
    const request = fake.all(REQUEST)[0]!;
    expect(request.spec.state).toBe('SUCCEEDED');
    expect(request.spec.terminateApplied).toBe(false);
    expect(String(request.spec.terminateError)).toContain('取消类型错误');
  });

  it('订单页申请的旧记录（无 serviceId）审核时不碰实例', async () => {
    const fake = createFakeExtensions();
    seedScenario(fake, { serviceState: 'ACTIVE' });
    fake.seed(
      REQUEST,
      {
        orderId: 'order-1',
        userId: 'user-1',
        amount: 7200,
        currency: 'CNY',
        reason: null,
        state: 'PENDING',
        reviewerId: null,
        reviewReason: null,
        failureReason: null,
        destination: 'WALLET',
        idempotencyKey: null,
        // 旧数据没有这两个字段（schema default 补齐）
        serviceId: null,
        suspendApplied: false,
        terminateApplied: false,
        terminateError: null,
      },
      'req-legacy',
    );
    const p = provider();
    vi.mocked(providerForProduct).mockReturnValue(p as never);
    bindContext(
      makeCtx(
        fake,
        vi.fn(async () => ({})),
      ),
    );
    await reviewRefundRequest({
      params: { id: 'req-legacy' },
      body: { decision: 'approve' },
      user: ADMIN,
    } as never);
    expect(p.terminate).not.toHaveBeenCalled();
    expect(p.resume).not.toHaveBeenCalled();
    expect(fake.all(SERVICE)[0]!.spec.state).toBe('ACTIVE');
  });
});
