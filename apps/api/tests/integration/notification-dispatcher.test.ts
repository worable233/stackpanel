import { afterAll, describe, expect, it } from 'vitest';
import type { EventBus, NotificationChannel, NotificationDispatch } from '@stackpanel/sdk';
import { present } from '../helpers.ts';

const { getPrisma } = await import('../../src/plugins/prisma.ts');
const { NotificationDispatcher } = await import('../../src/notifications/dispatcher.ts');

const dbAvailable = await (async () => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

const noopEvents: EventBus = {
  publish: () => {},
  subscribe: () => () => {},
  intercept: () => () => {},
  waterfall: <T>(_topic: string, value: T): T => value,
};

describe.skipIf(!dbAvailable)('notification dispatcher (real DB)', () => {
  const db = getPrisma();
  const notificationId = `it-dispatch-${Date.now()}`;

  afterAll(async () => {
    await db.notificationDelivery.deleteMany({ where: { notificationId } });
  });

  it('persists a durable delivery record and delivers via the channel', async () => {
    const delivered: NotificationDispatch[] = [];
    const channel: NotificationChannel = {
      id: 'it-email',
      name: 'Integration email',
      deliver: async (dispatch) => {
        delivered.push(dispatch);
      },
    };
    const dispatcher = new NotificationDispatcher({
      db,
      events: noopEvents,
      getChannels: () => [channel],
      logger: { warn: () => {} },
    });

    const view = notificationView(notificationId);
    const count = await dispatcher.dispatch(view, 'user-it');

    expect(count).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(present(delivered[0]).notificationId).toBe(notificationId);

    const row = await db.notificationDelivery.findUnique({
      where: { notificationId_channelId: { notificationId, channelId: 'it-email' } },
    });
    expect(row?.status).toBe('DELIVERED');
    expect(row?.deliveredAt).toBeInstanceOf(Date);
  });

  it('keeps a failed delivery PENDING with backoff, then sweep retries to success', async () => {
    let fail = true;
    const channel: NotificationChannel = {
      id: 'it-email-retry',
      name: 'Integration retry',
      deliver: async () => {
        if (fail) throw new Error('smtp down');
      },
    };
    const dispatcher = new NotificationDispatcher({
      db,
      events: noopEvents,
      getChannels: () => [channel],
      logger: { warn: () => {} },
    });

    await dispatcher.dispatch(notificationView(notificationId), 'user-it');
    const pending = present(
      await db.notificationDelivery.findUnique({
        where: { notificationId_channelId: { notificationId, channelId: 'it-email-retry' } },
      }),
      'pending delivery',
    );
    expect(pending.status).toBe('PENDING');
    expect(pending.attempts).toBe(1);
    expect(pending.lastError).toBe('smtp down');

    // Force the record due now, then let the sweep succeed.
    fail = false;
    await db.notificationDelivery.update({
      where: { id: pending.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await dispatcher.sweep();

    const done = await db.notificationDelivery.findUnique({ where: { id: pending.id } });
    expect(done?.status).toBe('DELIVERED');
  });

  it('upsert merges a replay into the same delivery row (idempotency)', async () => {
    const channel: NotificationChannel = {
      id: 'it-email-idem',
      name: 'Integration idempotent',
      deliver: async () => {},
    };
    const dispatcher = new NotificationDispatcher({
      db,
      events: noopEvents,
      getChannels: () => [channel],
      logger: { warn: () => {} },
    });

    await dispatcher.dispatch(notificationView(notificationId), 'user-it');
    await dispatcher.dispatch(notificationView(notificationId), 'user-it');

    const rows = await db.notificationDelivery.findMany({
      where: { notificationId, channelId: 'it-email-idem' },
    });
    expect(rows).toHaveLength(1);
  });
});

function notificationView(id: string) {
  return {
    id,
    type: 'order.paid',
    title: '支付成功',
    body: '订单已支付',
    link: '/account/orders',
    data: { orderId: 'o-1' },
    status: 'success' as const,
    progress: null,
    readAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
