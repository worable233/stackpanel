import { beforeEach, describe, expect, it } from 'vitest';
import type { NotificationChannel, NotificationTypeDefinition } from '@stackpanel/sdk';
import { INAPP_CHANNEL_ID } from '@stackpanel/sdk';
import { KernelNotificationPolicyService } from '../../src/notifications/policy-service.ts';

/**
 * Minimal in-memory fake of the two models the policy service touches:
 * `notificationPreference` (user overrides) and `setting` (admin policy).
 */
function createFakeDb() {
  const prefs: Array<{ userId: string; type: string; channelId: string; enabled: boolean }> = [];
  const settings = new Map<string, unknown>();
  return {
    prefs,
    settings,
    notificationPreference: {
      async findMany(args: { where: { userId: string; type?: string; channelId?: string } }) {
        return prefs.filter(
          (row) =>
            row.userId === args.where.userId &&
            (args.where.type === undefined || row.type === args.where.type) &&
            (args.where.channelId === undefined || row.channelId === args.where.channelId),
        );
      },
      async upsert(args: {
        where: { userId_type_channelId: { userId: string; type: string; channelId: string } };
        create: { userId: string; type: string; channelId: string; enabled: boolean };
        update: { enabled: boolean };
      }) {
        const { userId, type, channelId } = args.where.userId_type_channelId;
        const existing = prefs.find(
          (row) => row.userId === userId && row.type === type && row.channelId === channelId,
        );
        if (existing) {
          existing.enabled = args.update.enabled;
          return existing;
        }
        const row = {
          userId,
          type,
          channelId,
          enabled: args.create.enabled,
        };
        prefs.push(row);
        return row;
      },
      async deleteMany(args: { where: { userId: string; type?: { in: string[] } } }) {
        const keep = [];
        let count = 0;
        for (const row of prefs) {
          const matchesUser = row.userId === args.where.userId;
          const matchesType =
            args.where.type === undefined || args.where.type.in.includes(row.type);
          if (matchesUser && matchesType) count += 1;
          else keep.push(row);
        }
        prefs.length = 0;
        prefs.push(...keep);
        return { count };
      },
    },
    setting: {
      async findUnique(args: { where: { key: string } }) {
        const value = settings.get(args.where.key);
        return value === undefined ? null : { key: args.where.key, value };
      },
      async upsert(args: {
        where: { key: string };
        create: { key: string; value: unknown };
        update: { value: unknown };
      }) {
        settings.set(args.where.key, args.update.value ?? args.create.value);
        return { key: args.where.key, value: settings.get(args.where.key) };
      },
    },
  };
}

const email: NotificationChannel = { id: 'smtp', name: '邮件', deliver: async () => {} };

function makeService(definitions: NotificationTypeDefinition[] = [], db = createFakeDb()) {
  const service = new KernelNotificationPolicyService({
    db: db as never,
    getChannels: () => [email],
    getTypeDefinitions: () => definitions,
    logger: { warn: () => {} },
  });
  return { service, db };
}

describe('KernelNotificationPolicyService', () => {
  let db: ReturnType<typeof createFakeDb>;

  beforeEach(() => {
    db = createFakeDb();
  });

  it('treats undeclared types as always enabled (no config entry = cannot disable)', async () => {
    const { service } = makeService([], db);
    expect(await service.isEnabled('user-1', 'register.verification_code', email.id)).toBe(true);
    // An undeclared type never appears in the catalog, so it cannot be turned off.
    const view = await service.listForUser('user-1');
    expect(view.types.some((t) => t.type === 'register.verification_code')).toBe(false);
  });

  it('lists declared types with a channel per entry and defaults to all channels', async () => {
    const { service } = makeService(
      [{ type: 'order.paid', category: 'store', label: '支付成功' }],
      db,
    );
    const view = await service.listForUser('user-1');
    const entry = view.types.find((t) => t.type === 'order.paid')!;
    const channels = entry.channels.map((c) => c.channelId).sort();
    expect(channels).toEqual([INAPP_CHANNEL_ID, 'smtp'].sort());
    expect(entry.channels.every((c) => c.enabled)).toBe(true);
  });

  it('defaults a type with defaultChannels to only those channels', async () => {
    const { service } = makeService(
      [
        {
          type: 'service.provisioning',
          category: 'store',
          label: '开通中',
          defaultChannels: [INAPP_CHANNEL_ID],
        },
      ],
      db,
    );
    const view = await service.listForUser('user-1');
    const entry = view.types.find((t) => t.type === 'service.provisioning')!;
    const inapp = entry.channels.find((c) => c.channelId === INAPP_CHANNEL_ID)!;
    const smtp = entry.channels.find((c) => c.channelId === 'smtp')!;
    expect(inapp.enabled).toBe(true);
    expect(smtp.enabled).toBe(false);
  });

  it('applies a user override on a configurable channel', async () => {
    const defs: NotificationTypeDefinition[] = [
      { type: 'order.paid', category: 'store', label: '支付成功' },
    ];
    const { service } = makeService(defs, db);
    await service.updateForUser('user-1', [
      { type: 'order.paid', channelId: 'smtp', enabled: false },
    ]);
    expect(await service.isEnabled('user-1', 'order.paid', 'smtp')).toBe(false);
    expect(await service.isEnabled('user-1', 'order.paid', INAPP_CHANNEL_ID)).toBe(true);
  });

  it('ignores overrides for undeclared types and for locked types', async () => {
    const defs: NotificationTypeDefinition[] = [
      { type: 'order.paid', category: 'store', label: '支付成功' },
    ];
    const { service } = makeService(defs, db);
    // Undeclared: silently ignored, still enabled.
    await service.updateForUser('user-1', [{ type: 'nope', channelId: 'smtp', enabled: false }]);
    expect(await service.isEnabled('user-1', 'nope', 'smtp')).toBe(true);

    // Locked by admin: user override does not take effect.
    await service.updatePolicy({ types: { 'order.paid': { locked: true } } });
    await service.updateForUser('user-1', [
      { type: 'order.paid', channelId: 'smtp', enabled: false },
    ]);
    expect(await service.isEnabled('user-1', 'order.paid', 'smtp')).toBe(true);
  });

  it('lets an admin globally disable a type on every channel', async () => {
    const defs: NotificationTypeDefinition[] = [
      { type: 'order.paid', category: 'store', label: '支付成功' },
    ];
    const { service } = makeService(defs, db);
    await service.updatePolicy({ types: { 'order.paid': { enabled: false } } });
    expect(await service.isEnabled('user-1', 'order.paid', 'smtp')).toBe(false);
    expect(await service.isEnabled('user-1', 'order.paid', INAPP_CHANNEL_ID)).toBe(false);
    const enabled = await service.enabledChannels('user-1', 'order.paid');
    expect(enabled?.size).toBe(0);
  });

  it('resolves the most specific prefix definition (exact wins)', async () => {
    const defs: NotificationTypeDefinition[] = [
      { type: 'system.plugin.*', category: 'system', label: '插件' },
      { type: 'system.plugin.install', category: 'system', label: '安装' },
    ];
    const { service } = makeService(defs, db);
    await service.updatePolicy({ types: { 'system.plugin.*': { enabled: false } } });
    // Exact entry has no policy → still enabled.
    expect(await service.isEnabled('user-1', 'system.plugin.install', 'smtp')).toBe(true);
    // A sibling only matches the prefix → disabled.
    expect(await service.isEnabled('user-1', 'system.plugin.remove', 'smtp')).toBe(false);
  });

  it('returns null from enabledChannels for an undeclared type (no filtering)', async () => {
    const { service } = makeService([], db);
    expect(await service.enabledChannels('user-1', 'anything.else')).toBeNull();
  });

  it('reports in-app exclusions for types the user silenced on inapp', async () => {
    const defs: NotificationTypeDefinition[] = [
      { type: 'order.paid', category: 'store', label: '支付成功' },
      { type: 'agent.*', category: 'agent', label: 'Agent', defaultChannels: [INAPP_CHANNEL_ID] },
    ];
    const { service } = makeService(defs, db);
    await service.updateForUser('user-1', [
      { type: 'order.paid', channelId: INAPP_CHANNEL_ID, enabled: false },
    ]);
    const exclusions = await service.inAppExclusions('user-1');
    expect(exclusions?.exact).toContain('order.paid');
    // agent.* is enabled on inapp by default → not excluded.
    expect(exclusions?.prefixes).toEqual([]);
  });

  it('resetForUser clears overrides back to defaults', async () => {
    const defs: NotificationTypeDefinition[] = [
      { type: 'order.paid', category: 'store', label: '支付成功' },
    ];
    const { service } = makeService(defs, db);
    await service.updateForUser('user-1', [
      { type: 'order.paid', channelId: 'smtp', enabled: false },
    ]);
    expect(await service.isEnabled('user-1', 'order.paid', 'smtp')).toBe(false);
    await service.resetForUser('user-1');
    expect(await service.isEnabled('user-1', 'order.paid', 'smtp')).toBe(true);
  });

  it('catalog exposes both in-app and plugin channels', async () => {
    const { service } = makeService([], db);
    const view = await service.listPolicy();
    expect(view.channels.map((c) => c.id).sort()).toEqual([INAPP_CHANNEL_ID, 'smtp'].sort());
    expect(view.channels.find((c) => c.id === INAPP_CHANNEL_ID)?.inApp).toBe(true);
  });
});

describe('account notification catalog boundaries', () => {
  const definitions: NotificationTypeDefinition[] = [
    { type: 'order.paid', category: 'store', label: '订单支付成功' },
    { type: 'operations.failure', category: 'operations', label: '运营告警', audience: 'admin' },
    { type: 'business.*', category: 'store', label: '业务通知' },
    { type: 'business.internal', category: 'operations', label: '内部通知', audience: 'admin' },
  ];

  it('excludes operator types and empty categories from account settings, regardless of user id', async () => {
    const { service } = makeService(definitions);
    for (const userId of ['ordinary-user', 'administrator']) {
      const view = await service.listForUser(userId);
      expect(view.types.map((row) => row.type)).toEqual(['business.*', 'order.paid', 'agent.*']);
      expect(view.categories.map((row) => row.id)).toEqual(['store', 'agent']);
    }
    const policy = await service.listPolicy();
    expect(policy.types.map((row) => row.type)).toEqual(
      expect.arrayContaining([
        'system.plugin.*',
        'system.theme.*',
        'system.frontend-apply',
        'operations.failure',
        'business.internal',
        'order.paid',
      ]),
    );
    expect(policy.types.find((row) => row.type === 'operations.failure')?.userConfigurable).toBe(
      false,
    );
  });

  it('rejects direct account writes to operator types, including exact types under a user wildcard', async () => {
    const { service, db } = makeService(definitions);
    await service.updateForUser('user-1', [
      { type: 'system.plugin.enable', channelId: 'inapp', enabled: false },
      { type: 'operations.failure', channelId: 'inapp', enabled: false },
      { type: 'business.internal', channelId: 'inapp', enabled: false },
      { type: 'order.paid', channelId: 'smtp', enabled: false },
    ]);
    expect(db.prefs).toEqual([
      { userId: 'user-1', type: 'order.paid', channelId: 'smtp', enabled: false },
    ]);
  });

  it('does not let legacy account overrides silence operator notifications', async () => {
    const { service, db } = makeService(definitions);
    db.prefs.push({
      userId: 'user-1',
      type: 'operations.failure',
      channelId: 'inapp',
      enabled: false,
    });
    expect(await service.isEnabled('user-1', 'operations.failure', 'inapp')).toBe(true);
    expect(await service.enabledChannels('user-1', 'operations.failure')).toContain('inapp');
    expect(await service.inAppExclusions('user-1')).toBeNull();
  });

  it('scopes both targeted and whole-account reset to account types', async () => {
    const { service, db } = makeService(definitions);
    db.prefs.push(
      { userId: 'user-1', type: 'operations.failure', channelId: 'inapp', enabled: false },
      { userId: 'user-1', type: 'order.paid', channelId: 'inapp', enabled: false },
    );
    await service.resetForUser('user-1', ['operations.failure']);
    expect(db.prefs).toHaveLength(2);
    await service.resetForUser('user-1');
    expect(db.prefs).toEqual([
      { userId: 'user-1', type: 'operations.failure', channelId: 'inapp', enabled: false },
    ]);
  });

  it('keeps built-in operator types private when a plugin redeclares them', async () => {
    const { service } = makeService([
      { type: 'system.plugin.*', category: 'system', label: '重声明' },
      { type: 'system.plugin.install', category: 'system', label: '安装' },
    ]);
    expect(
      (await service.listForUser('user-1')).types.some((row) => row.type === 'system.plugin.*'),
    ).toBe(false);
    expect(
      (await service.listForUser('user-1')).types.some(
        (row) => row.type === 'system.plugin.install',
      ),
    ).toBe(false);
  });

  it('a global disable is read-only and cannot be re-enabled by an existing user override', async () => {
    const { service, db } = makeService(definitions);
    db.prefs.push({ userId: 'user-1', type: 'order.paid', channelId: 'inapp', enabled: true });
    await service.updatePolicy({ types: { 'order.paid': { enabled: false } } });
    const row = (await service.listForUser('user-1')).types.find(
      (row) => row.type === 'order.paid',
    )!;
    expect(row.configurable).toBe(false);
    expect(row.channels.every((channel) => !channel.enabled && !channel.configurable)).toBe(true);
    expect((await service.inAppExclusions('user-1'))?.exact).toContain('order.paid');
  });
});
