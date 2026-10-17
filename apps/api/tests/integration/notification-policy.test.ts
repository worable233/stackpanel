import { afterAll, describe, expect, it } from 'vitest';
import type { NotificationChannel, NotificationTypeDefinition } from '@stackpanel/sdk';
import { INAPP_CHANNEL_ID } from '@stackpanel/sdk';

const { getPrisma } = await import('../../src/plugins/prisma.ts');
const { KernelNotificationPolicyService } =
  await import('../../src/notifications/policy-service.ts');

const dbAvailable = await (async () => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

const email: NotificationChannel = {
  id: 'it-smtp',
  name: 'Integration SMTP',
  deliver: async () => {},
};

describe.skipIf(!dbAvailable)('notification policy (real DB)', () => {
  const db = getPrisma();
  const userIds: string[] = [];

  afterAll(async () => {
    if (userIds.length > 0) {
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    }
    // Reset the shared admin policy setting touched by these tests.
    await db.setting.deleteMany({ where: { key: 'notifications.policy' } });
  });

  async function makeUser(): Promise<string> {
    const user = await db.user.create({
      data: { email: `policy-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  }

  const definitions: NotificationTypeDefinition[] = [
    { type: 'it.order.paid', category: 'store', label: '支付成功' },
    {
      type: 'it.only.inapp',
      category: 'store',
      label: '仅站内',
      defaultChannels: [INAPP_CHANNEL_ID],
    },
  ];

  function service() {
    return new KernelNotificationPolicyService({
      db,
      getChannels: () => [email],
      getTypeDefinitions: () => definitions,
      logger: { warn: () => {} },
    });
  }

  it('persists per-user overrides and survives a fresh service instance', async () => {
    const userId = await makeUser();
    await service().updateForUser(userId, [
      { type: 'it.order.paid', channelId: 'it-smtp', enabled: false },
    ]);

    // A new instance (no cache) reads the same row.
    const fresh = service();
    expect(await fresh.isEnabled(userId, 'it.order.paid', 'it-smtp')).toBe(false);
    expect(await fresh.isEnabled(userId, 'it.order.paid', INAPP_CHANNEL_ID)).toBe(true);

    const row = await db.notificationPreference.findUnique({
      where: {
        userId_type_channelId: { userId, type: 'it.order.paid', channelId: 'it-smtp' },
      },
    });
    expect(row?.enabled).toBe(false);
  });

  it('applies an admin global disable across a fresh instance', async () => {
    const userId = await makeUser();
    await service().updatePolicy({ types: { 'it.order.paid': { enabled: false } } });

    const fresh = service();
    expect(await fresh.isEnabled(userId, 'it.order.paid', 'it-smtp')).toBe(false);
    expect(await db.setting.findUnique({ where: { key: 'notifications.policy' } })).toBeTruthy();

    await service().updatePolicy({ types: { 'it.order.paid': { enabled: true } } });
  });

  it('is idempotent on upsert for the same (user, type, channel)', async () => {
    const userId = await makeUser();
    await service().updateForUser(userId, [
      { type: 'it.order.paid', channelId: 'it-smtp', enabled: false },
      { type: 'it.order.paid', channelId: 'it-smtp', enabled: false },
    ]);
    const count = await db.notificationPreference.count({ where: { userId } });
    expect(count).toBe(1);
  });

  it('enforces the unique index and cascades on user delete', async () => {
    const userId = await makeUser();
    await service().updateForUser(userId, [
      { type: 'it.order.paid', channelId: 'it-smtp', enabled: true },
    ]);
    await db.user.delete({ where: { id: userId } });
    const remaining = await db.notificationPreference.count({ where: { userId } });
    expect(remaining).toBe(0);
  });
});
