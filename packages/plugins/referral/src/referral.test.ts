import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CustomModelDefinition,
  ExtensionClient,
  ExtensionInstance,
  PluginContext,
} from '@stackpanel/sdk';
import { ExtensionUniqueViolation, ExtensionVersionConflict } from '@stackpanel/sdk';
import { attributeRegistration } from './attribution';
import { bindContext, resetContext } from './context';
import {
  codeModel,
  configModel,
  recordModel,
  type ReferralCode,
  type ReferralConfig,
  type ReferralRecord,
} from './data';
import { awardInvitee, awardInviter, qualifyByOrder, REFERRAL_REFERENCE_TYPE } from './rewards';

interface Stored {
  name: string;
  spec: Record<string, unknown>;
  version: number;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const INVITER = 'user-inviter';
const CODE = 'ABCDEFGHJ';

/** Ledger 里一条入账记录，key = `${referenceType}:${referenceId}`。 */
interface LedgerRow {
  userId: string;
  amount: number;
  currency: string;
  type: string;
  referenceType: string;
  referenceId: string;
  note: string;
}

/**
 * 最小内存版 ExtensionClient：按 kind 存实例，`update` 模拟乐观锁,
 * `create` 在实例名重复时抛 {@link ExtensionUniqueViolation}（对齐内核的
 * `inviteeId` 唯一索引语义）。
 */
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
    if (field === 'ownerId') return row.ownerId;
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
      opts?: { name?: string; ownerId?: string },
    ) {
      const name = opts?.name ?? `${model.kind}-${++seq}`;
      if (table(model.kind).has(name)) {
        throw new ExtensionUniqueViolation(`唯一约束冲突：${model.kind}`);
      }
      const row: Stored = {
        name,
        spec: { ...spec },
        version: 1,
        ownerId: opts?.ownerId ?? null,
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
        for (const [key, op] of Object.entries(patch)) {
          if ('set' in op) row.spec[key] = op.set;
          else if ('inc' in op) row.spec[key] = ((row.spec[key] as number) ?? 0) + op.inc;
          else if ('dec' in op) row.spec[key] = ((row.spec[key] as number) ?? 0) - op.dec;
        }
        row.version += 1;
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
        ownerId: null,
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

interface FakeWorld {
  ctx: PluginContext;
  fake: ReturnType<typeof createFakeExtensions>;
  ledger: LedgerRow[];
  credits: LedgerRow[];
}

/**
 * 组装一个绑定到内存后端的 PluginContext。
 *
 * `wallet.credit` 模拟内核账本的 `@@unique([referenceType, referenceId])`:
 * 重复 referenceId 抛 P2002（用 `{code:'P2002'}` 对象模拟），验证幂等分支。
 */
function makeWorld(): FakeWorld {
  const fake = createFakeExtensions();
  const ledger: LedgerRow[] = [];
  const credits: LedgerRow[] = [];
  const credit = async (
    userId: string,
    amount: number,
    currency: string,
    meta: {
      type: string;
      referenceType: string;
      referenceId: string;
      note: string;
    },
  ) => {
    const key = `${meta.referenceType}:${meta.referenceId}`;
    if (ledger.some((row) => `${row.referenceType}:${row.referenceId}` === key)) {
      const conflict = new Error('unique constraint') as Error & { code: string };
      conflict.code = 'P2002';
      throw conflict;
    }
    const row: LedgerRow = { userId, amount, currency, ...meta };
    ledger.push(row);
    credits.push(row);
    return { id: `${ledger.length}`, ...row };
  };
  const tx = (async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ extensions: fake.client, wallet: { credit } })) as PluginContext['tx'];
  const ctx = {
    manifest: { id: 'referral', name: '推广插件', version: '0.1.0' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    events: {
      publish: () => {},
      subscribe: () => () => {},
      intercept: () => () => {},
      waterfall: <T>(_topic: string, value: T): T => value,
    },
    extensions: fake.client,
    tx,
    secrets: {
      isAvailable: () => true,
      get: async () => null,
      set: async () => {},
      remove: async () => {},
    },
    payments: {} as never,
    wallet: { credit } as never,
    fx: {} as never,
    auth: {} as never,
    notifications: {} as never,
    state: {} as never,
    jobs: {} as never,
    cache: {} as never,
    media: {} as never,
    effect: () => () => {},
    provide: () => () => {},
    getService: () => undefined,
    requireService: () => {
      throw new Error('no service');
    },
    registerExtension: () => () => {},
    getExtensions: () => [],
    getExtensionsWithOwner: () => [],
  } as unknown as PluginContext;
  return { ctx, fake, ledger, credits };
}

function baseConfig(overrides: Partial<ReferralConfig> = {}): ReferralConfig {
  return {
    enabled: true,
    trigger: 'register',
    rewardAmount: 500,
    inviteeRewardAmount: 200,
    freezeDays: 7,
    cookieDays: 30,
    maxInvitesPerUser: 0,
    sameIpLimit: 0,
    currency: 'CNY',
    ...overrides,
  };
}

function seedCode(fake: ReturnType<typeof createFakeExtensions>, overrides: Partial<ReferralCode> = {}) {
  return fake.seed(
    codeModel.kind,
    {
      ownerId: INVITER,
      code: CODE,
      label: '',
      state: 'active',
      rewardAmount: null,
      signupCount: 0,
      ...overrides,
    } as Record<string, unknown>,
    'code-row',
  );
}

describe('referral rewards', () => {
  beforeEach(() => {
    resetContext();
  });

  it('register 档：先发被邀请人再发推广人，两个奖励都入账（乐观锁回归）', async () => {
    const world = makeWorld();
    bindContext(world.ctx);
    seedCode(world.fake);

    // 这条曾因「用陈旧 record 版本发推广人奖励」而静默失败：inviter 永远 pending。
    await attributeRegistration({
      userId: 'user-invitee',
      email: 'invitee@example.com',
      affid: CODE,
      ip: '1.1.1.1',
      config: baseConfig({ trigger: 'register' }),
    });

    const record = world.fake.all(recordModel.kind)[0];
    expect(record.spec.inviterState).toBe('paid');
    expect(record.spec.inviteeState).toBe('paid');
    expect(world.credits.map((row) => row.referenceId).sort()).toEqual([
      'user-invitee:invitee',
      'user-invitee:inviter',
    ]);
    const types = world.credits.map((row) => row.type).sort();
    expect(types).toEqual(['REFERRAL_INVITEE_REWARD', 'REFERRAL_REWARD']);
  });

  it('first_order 档：归因只发被邀请人，推广人保持 pending，支付后补发', async () => {
    const world = makeWorld();
    bindContext(world.ctx);
    seedCode(world.fake);

    await attributeRegistration({
      userId: 'user-invitee',
      email: 'invitee@example.com',
      affid: CODE,
      ip: '1.1.1.1',
      config: baseConfig({ trigger: 'first_order' }),
    });

    let record = world.fake.all(recordModel.kind)[0];
    expect(record.spec.inviterState).toBe('pending');
    expect(world.credits).toHaveLength(1);
    expect(world.credits[0]!.type).toBe('REFERRAL_INVITEE_REWARD');

    await qualifyByOrder(
      record as unknown as ExtensionInstance<ReferralRecord>,
      'order-1',
      world.fake.all(codeModel.kind)[0]!.spec as unknown as ReferralCode,
      baseConfig({ trigger: 'first_order' }),
    );

    record = world.fake.all(recordModel.kind)[0];
    expect(record.spec.inviterState).toBe('paid');
    expect(record.spec.qualifiedOrderId).toBe('order-1');
    expect(world.credits).toHaveLength(2);
    expect(world.credits[1]!.type).toBe('REFERRAL_REWARD');
  });

  it('register_frozen 档：落 pending + 大数值 freezeUntil（int4 溢出回归）', async () => {
    const world = makeWorld();
    bindContext(world.ctx);
    seedCode(world.fake);

    await attributeRegistration({
      userId: 'user-invitee',
      email: 'invitee@example.com',
      affid: CODE,
      ip: '1.1.1.1',
      config: baseConfig({ trigger: 'register_frozen', freezeDays: 7 }),
    });

    const record = world.fake.all(recordModel.kind)[0];
    expect(record.spec.inviterState).toBe('pending');
    // epoch ms ≈ 1.7e12，超过 int4（2.1e9）。字段类型必须能装下它。
    expect(typeof record.spec.freezeUntil).toBe('number');
    expect(record.spec.freezeUntil as number).toBeGreaterThan(2_147_483_647);
    // 索引列必须声明为 number（double precision），不能是 integer。
    const idx = recordModel.indexes?.find((index) => index.fields.includes('freezeUntil'));
    expect(idx?.types.freezeUntil).toBe('number');
  });

  it('幂等：同一 referenceId 重复入账被唯一约束拦下，不重复加钱', async () => {
    const world = makeWorld();
    bindContext(world.ctx);

    const created = await world.ctx.extensions.create<ReferralRecord>(
      recordModel,
      {
        code: CODE,
        inviterId: INVITER,
        inviteeId: 'user-invitee',
        inviteeEmail: '',
        trigger: 'first_order',
        inviterState: 'pending',
        inviteeState: 'none',
        freezeUntil: 0,
        rewardAmount: 500,
        inviteeRewardAmount: 200,
        registerIp: '',
        qualifiedOrderId: null,
        qualifiedAt: null,
        paidAt: null,
      } as ReferralRecord,
      { name: 'user-invitee' },
    );

    const first = await awardInviter(created, null, baseConfig());
    expect(first).toBe('paid');
    // 再用陈旧快照发一次（模拟事件重放）：应命中 P2002 → already-paid，不重复入账。
    const second = await awardInviter(created, null, baseConfig());
    expect(second).toBe('already-paid');
    expect(world.credits.filter((row) => row.type === 'REFERRAL_REWARD')).toHaveLength(1);
  });

  it('rejects 自己邀请自己：不建记录、不发奖', async () => {
    const world = makeWorld();
    bindContext(world.ctx);
    seedCode(world.fake, { ownerId: INVITER });

    await attributeRegistration({
      userId: INVITER,
      email: 'inviter@example.com',
      affid: CODE,
      ip: '1.1.1.1',
      config: baseConfig(),
    });

    expect(world.fake.all(recordModel.kind)).toHaveLength(0);
    expect(world.credits).toHaveLength(0);
  });

  it('同 IP 超限：归因落库但标 rejected、不发奖', async () => {
    const world = makeWorld();
    bindContext(world.ctx);
    seedCode(world.fake);
    // 先占掉这个 IP 的一条记录。
    world.fake.seed(recordModel.kind, {
      code: CODE,
      inviterId: INVITER,
      inviteeId: 'someone-else',
      inviteeEmail: '',
      trigger: 'register',
      inviterState: 'paid',
      inviteeState: 'none',
      freezeUntil: 0,
      rewardAmount: 0,
      inviteeRewardAmount: 0,
      registerIp: '9.9.9.9',
      qualifiedOrderId: null,
      qualifiedAt: null,
      paidAt: null,
    });

    await attributeRegistration({
      userId: 'user-invitee',
      email: 'invitee@example.com',
      affid: CODE,
      ip: '9.9.9.9',
      config: baseConfig({ sameIpLimit: 1 }),
    });

    const record = world.fake.all(recordModel.kind).find((row) => row.name === 'user-invitee');
    expect(record?.spec.inviterState).toBe('rejected');
    expect(world.credits).toHaveLength(0);
  });

  it('推广人单码奖励覆盖全局默认', async () => {
    const world = makeWorld();
    bindContext(world.ctx);
    seedCode(world.fake, { rewardAmount: 1234 });

    await attributeRegistration({
      userId: 'user-invitee',
      email: 'invitee@example.com',
      affid: CODE,
      ip: '1.1.1.1',
      config: baseConfig({ trigger: 'register', rewardAmount: 500 }),
    });

    const inviterCredit = world.credits.find((row) => row.type === 'REFERRAL_REWARD');
    expect(inviterCredit?.amount).toBe(1234);
    expect(inviterCredit?.referenceType).toBe(REFERRAL_REFERENCE_TYPE);
  });

  it('配置模型存在且默认值稳定（防止误改触发语义）', () => {
    const parsed = configModel.schema.parse({}) as ReferralConfig;
    expect(parsed.trigger).toBe('first_order');
    expect(parsed.currency).toBe('CNY');
    expect(parsed.sameIpLimit).toBe(1);
  });
});
