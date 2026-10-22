import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activate, provisionContext } from './test-harness.js';
import type { ProductTypeProvider } from '@stackpanel/sdk';

const DAY = 24 * 60 * 60 * 1000;

let harness: ReturnType<typeof activate>;

beforeEach(() => {
  harness = activate();
});

/** 从抛出的错误里取出稳定 code 与人类可读 detail（PluginError 的 message 是 code）。 */
function failureOf(error: unknown): { code: string; detail: string | undefined } {
  const value = error as { code?: unknown; detail?: unknown };
  return {
    code: typeof value.code === 'string' ? value.code : '',
    detail: typeof value.detail === 'string' ? value.detail : undefined,
  };
}

describe('会员商品：类型声明', () => {
  it('认领 membership 类型并声明权限组选择器', () => {
    const type = harness.productType();
    expect(type.fulfillmentTypes).toContain('membership');
    const groupField = (type.configFields ?? []).find((field) => field.name === 'groupId');
    expect(groupField).toBeDefined();
    // 候选项必须由商店动态填充，不能是写死的空数组让人没法选。
    expect(groupField?.optionsSource).toBe('permissionGroups');
  });

  it('configSchema 拒绝缺少 groupId 的商品配置', () => {
    const type = harness.productType();
    expect(type.configSchema?.safeParse({}).success).toBe(false);
    expect(type.configSchema?.safeParse({ groupId: 'group_vip' }).success).toBe(true);
  });
});

describe('会员商品：授予', () => {
  it('付款后把用户加入权限组并写入到期时间', async () => {
    const expiresAt = new Date(Date.now() + 30 * DAY).toISOString();
    const result = await harness.productType().provision(provisionContext({ expiresAt }));

    expect(result.status).toBe('ACTIVE');
    const grant = harness.auth.members.get('user-1:group_vip');
    expect(grant?.expiresAt?.toISOString()).toBe(expiresAt);
    // 内核读路径应立刻看到权益。
    await expect(harness.auth.hasPermission('user-1', 'group_vip')).resolves.toBe(true);
    // 插件自己留了撤销依据。
    expect(harness.extensions.all()).toHaveLength(1);
    expect(harness.extensions.all()[0]?.spec['orderId']).toBe('order-1');
  });

  it('重复投递同一订单不会二次授予，也不会延长', async () => {
    const first = await harness.productType().provision(provisionContext());
    const second = await harness.productType().provision(provisionContext());

    expect(harness.auth.grantCalls).toHaveLength(1);
    expect(harness.extensions.all()).toHaveLength(1);
    expect(second.status).toBe('ACTIVE');
    expect((second.runtime as { membership: { expiresAt: string } }).membership.expiresAt).toBe(
      (first.runtime as { membership: { expiresAt: string } }).membership.expiresAt,
    );
  });

  it('已到期的授予不会被迟到的重放重新激活', async () => {
    await harness.productType().provision(provisionContext({ expiresAt: new Date(Date.now() + DAY).toISOString() }));
    // 模拟清扫把记录标记为撤销。
    const row = harness.extensions.all()[0]!;
    await harness.extensions.update(
      {} as never,
      row.name,
      { ...row.spec, status: 'REVOKED' },
      { expectedVersion: row.version },
    );
    await harness.productType().provision(provisionContext());
    // 仍然只有一条记录、没有新的授予调用。
    expect(harness.extensions.all()).toHaveLength(1);
    expect(harness.auth.grantCalls).toHaveLength(1);
  });

  it('拒绝授予管理员组（不能把提权做成 SKU）', async () => {
    const error = await harness
      .productType()
      .provision(provisionContext({ groupId: 'group_admin' }))
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(failureOf(error).code).toBe('store.membership.not_configured');
    expect(failureOf(error).detail).toContain('商品未配置会员权益');
    expect(harness.auth.members.size).toBe(0);
  });

  it('没有到期时间且未允许永久时拒绝开通', async () => {
    const error = await harness
      .productType()
      .provision(provisionContext({ expiresAt: null }))
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(failureOf(error).code).toBe('store.membership.not_configured');
    expect(harness.auth.members.size).toBe(0);
  });

  it('显式允许永久时授予永久成员（expiresAt 为 null）', async () => {
    const result = await harness.productType().provision(
      provisionContext({ expiresAt: null, allowPermanent: true }),
    );
    expect(result.status).toBe('ACTIVE');
    const grant = harness.auth.members.get('user-1:group_vip');
    expect(grant?.expiresAt).toBeNull();
    const row = harness.extensions.all()[0]!;
    expect(row.spec['expiresAtMs']).toBeNull();
  });

  it('已有永久成员时，限时会员商品的授予记录也记永久（避免误发到期通知）', async () => {
    // 管理员先手工授予永久成员。
    await harness.auth.grantUserGroup({ userId: 'user-1', groupId: 'group_vip', expiresAt: null });
    const expiresAt = new Date(Date.now() + 30 * DAY).toISOString();
    const result = await harness.productType().provision(provisionContext({ expiresAt }));

    expect(result.status).toBe('ACTIVE');
    // 内核不会把永久降级（见 test-harness），插件记录必须与内核实际生效值一致。
    expect(harness.auth.members.get('user-1:group_vip')?.expiresAt).toBeNull();
    const row = harness.extensions.all()[0]!;
    expect(row.spec['expiresAt']).toBeNull();
    expect(row.spec['expiresAtMs']).toBeNull();
    expect((result.runtime as { membership: { expiresAt: string | null } }).membership.expiresAt).toBeNull();
  });

  it('商品未配置权限组时拒绝开通', async () => {
    const error = await harness
      .productType()
      .provision(provisionContext({ groupId: null }))
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(failureOf(error).code).toBe('store.membership.not_configured');
  });
});

describe('会员商品：到期撤权', () => {
  it('读路径到期即失效（不依赖清扫任务）', async () => {
    // 到期时间设在 1 秒后，然后把系统时间推过去。
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    await harness.productType().provision(provisionContext({ expiresAt }));
    await expect(harness.auth.hasPermission('user-1', 'group_vip')).resolves.toBe(true);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 5000));
    await expect(harness.auth.hasPermission('user-1', 'group_vip')).resolves.toBe(false);
    await expect(harness.auth.listUserGroups('user-1')).resolves.toEqual([]);
    vi.useRealTimers();
  });

  it('清扫任务撤销到期权益并通知用户', async () => {
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    await harness.productType().provision(provisionContext({ expiresAt }));
    const sweep = harness.jobs.get('membership-sweep');
    expect(sweep).toBeDefined();

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 5000));
    await sweep!();
    vi.useRealTimers();

    expect(harness.auth.revokeCalls).toEqual([{ userId: 'user-1', groupId: 'group_vip' }]);
    const row = harness.extensions.all()[0]!;
    expect(row.spec['status']).toBe('REVOKED');
    expect(row.spec['revokeReason']).toBe('expired');
    expect(harness.notifications.some((notice) => notice['type'] === 'membership.expired')).toBe(
      true,
    );
  });

  it('清扫不碰永久会员', async () => {
    await harness.productType().provision(provisionContext({ expiresAt: null, allowPermanent: true }));
    await harness.jobs.get('membership-sweep')!();
    expect(harness.auth.revokeCalls).toEqual([]);
    expect(harness.extensions.all()[0]?.spec['status']).toBe('ACTIVE');
  });

  it('管理员把组改成永久后，清扫不得撤销它', async () => {
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    await harness.productType().provision(provisionContext({ expiresAt }));
    // 管理员接管：把这条成员关系改成永久。
    harness.auth.members.set('user-1:group_vip', {
      userId: 'user-1',
      groupId: 'group_vip',
      expiresAt: null,
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 5000));
    await harness.jobs.get('membership-sweep')!();
    vi.useRealTimers();

    // 记录被标记撤销，但内核成员关系（管理员的永久授予）保留。
    expect(harness.auth.revokeCalls).toEqual([]);
    expect(harness.auth.members.has('user-1:group_vip')).toBe(true);
  });

  it('store 的到期 suspend 钩子撤销对应权益', async () => {
    await harness.productType().provision(provisionContext());
    const provider = harness.fulfillmentProvider() as ProductTypeProvider;
    await provider.suspend?.({
      service: {
        id: 'svc-1',
        providerId: null,
        providerServiceId: null,
        runtime: { membership: { groupId: 'group_vip' } },
        credentialsRef: null,
        userId: 'user-1',
        orderId: 'order-1',
        productId: 'product-1',
        productName: 'VIP 年费会员',
        status: 'ACTIVE',
      },
      secrets: {
        isAvailable: () => true,
        get: async () => null,
        set: async () => {},
        remove: async () => {},
      },
    });
    expect(harness.auth.members.has('user-1:group_vip')).toBe(false);
  });
});

describe('会员商品：续费', () => {
  it('续费把内核成员关系与本插件记录一起延长', async () => {
    const firstExpiry = new Date(Date.now() + 30 * DAY).toISOString();
    await harness.productType().provision(provisionContext({ expiresAt: firstExpiry }));
    const nextExpiry = new Date(Date.now() + 395 * DAY).toISOString();

    const provider = harness.fulfillmentProvider() as ProductTypeProvider;
    await provider.renew?.(
      {
        service: {
          id: 'svc-1',
          providerId: null,
          providerServiceId: null,
          runtime: { membership: { groupId: 'group_vip' } },
          credentialsRef: null,
          userId: 'user-1',
          orderId: 'order-1',
          productId: 'product-1',
          productName: 'VIP 年费会员',
          status: 'ACTIVE',
        },
        secrets: {
          isAvailable: () => true,
          get: async () => null,
          set: async () => {},
          remove: async () => {},
        },
      },
      { newExpiresAt: nextExpiry, months: 12 },
    );

    expect(harness.auth.members.get('user-1:group_vip')?.expiresAt?.toISOString()).toBe(nextExpiry);
    expect(harness.extensions.all()[0]?.spec['expiresAt']).toBe(nextExpiry);
    expect(harness.extensions.all()[0]?.spec['expiresAtMs']).toBe(new Date(nextExpiry).getTime());
  });

  it('用户已有永久成员时，续费不把永久权益改成限时', async () => {
    const firstExpiry = new Date(Date.now() + 30 * DAY).toISOString();
    await harness.productType().provision(provisionContext({ expiresAt: firstExpiry }));
    // 管理员接管：把成员关系改成永久。
    await harness.auth.grantUserGroup({ userId: 'user-1', groupId: 'group_vip', expiresAt: null });

    const provider = harness.fulfillmentProvider() as ProductTypeProvider;
    const result = await provider.renew?.(
      {
        service: {
          id: 'svc-1',
          providerId: null,
          providerServiceId: null,
          runtime: { membership: { groupId: 'group_vip' } },
          credentialsRef: null,
          userId: 'user-1',
          orderId: 'order-1',
          productId: 'product-1',
          productName: 'VIP 年费会员',
          status: 'ACTIVE',
        },
        secrets: {
          isAvailable: () => true,
          get: async () => null,
          set: async () => {},
          remove: async () => {},
        },
      },
      { newExpiresAt: new Date(Date.now() + 395 * DAY).toISOString(), months: 12 },
    );

    expect(harness.auth.members.get('user-1:group_vip')?.expiresAt).toBeNull();
    expect(harness.extensions.all()[0]?.spec['expiresAt']).toBeNull();
    expect(harness.extensions.all()[0]?.spec['expiresAtMs']).toBeNull();
    expect((result as { message: string }).message).toContain('永久');
  });

  it('没有可续期的权益时抛错，不静默吞掉用户的续费', async () => {
    const provider = harness.fulfillmentProvider() as ProductTypeProvider;
    const error = await provider
      .renew?.(
        {
          service: {
            id: 'svc-1',
            providerId: null,
            providerServiceId: null,
            runtime: null,
            credentialsRef: null,
            userId: 'user-1',
            orderId: 'order-x',
            productId: 'product-1',
            productName: 'VIP 年费会员',
            status: 'ACTIVE',
          },
          secrets: {
            isAvailable: () => true,
            get: async () => null,
            set: async () => {},
            remove: async () => {},
          },
        },
        { newExpiresAt: new Date(Date.now() + DAY).toISOString(), months: 1 },
      )
      .then(() => null)
      .catch((caught: unknown) => caught);
    // 先因「找不到权益组」失败——两种失败都必须抛出而不是静默成功。
    expect(['store.membership.group_unknown', 'store.membership.not_renewable']).toContain(
      failureOf(error).code,
    );
  });
});

describe('会员商品：权益查询', () => {
  it('getDetail 只展示本订单对应的会员等级与折扣', async () => {
    await harness.productType().provision(provisionContext());
    const detail = await harness.productType().getDetail?.({
      service: {
        id: 'svc-1',
        providerId: null,
        providerServiceId: null,
        runtime: null,
        credentialsRef: null,
        userId: 'user-1',
        orderId: 'order-1',
        productId: 'product-1',
        productName: 'VIP 年费会员',
        status: 'ACTIVE',
      },
      secrets: {
        isAvailable: () => true,
        get: async () => null,
        set: async () => {},
        remove: async () => {},
      },
    });
    const labels = (detail?.fields ?? []).map((field) => field.label);
    expect(labels).toContain('会员等级');
    expect(labels).toContain('会员折扣');
    const level = detail?.fields.find((field) => field.label === '会员等级');
    expect(level?.value).toBe('VIP 会员');
  });
});
