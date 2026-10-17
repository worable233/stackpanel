import { describe, expect, it, vi } from 'vitest';
import type {
  EventBus,
  NotificationChannel,
  NotificationDispatch,
  NotificationPolicyService,
  NotificationView,
} from '@stackpanel/sdk';
import {
  NotificationDispatcher,
  type NotificationDispatcherOptions,
} from '../../src/notifications/dispatcher.ts';

/** Minimal in-memory fake of the fields the dispatcher touches. */
interface DeliveryRow {
  id: string;
  notificationId: string;
  channelId: string;
  userId: string;
  payload: unknown;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  deliveredAt: Date | null;
}

function createFakeDb() {
  const rows = new Map<string, DeliveryRow>();
  let seq = 0;
  const key = (notificationId: string, channelId: string) => `${notificationId}:${channelId}`;
  return {
    rows,
    notificationDelivery: {
      async upsert(args: {
        where: { notificationId_channelId: { notificationId: string; channelId: string } };
        create: Partial<DeliveryRow>;
        update: Partial<DeliveryRow>;
      }) {
        const { notificationId, channelId } = args.where.notificationId_channelId;
        const existing = rows.get(key(notificationId, channelId));
        if (existing) {
          Object.assign(existing, args.update);
          return existing;
        }
        // Mirror Prisma defaults that create() relies on.
        const row: DeliveryRow = Object.assign(
          {
            id: `d${++seq}`,
            payload: null,
            status: 'PENDING',
            attempts: 0,
            maxAttempts: 5,
            lastError: null,
            deliveredAt: null,
            nextAttemptAt: new Date(),
          } as DeliveryRow,
          args.create,
        );
        rows.set(key(notificationId, channelId), row);
        return row;
      },
      async findMany(args: {
        where: { status: string; nextAttemptAt: { lte: Date } };
        take: number;
      }) {
        return [...rows.values()]
          .filter(
            (row) =>
              row.status === args.where.status &&
              row.nextAttemptAt.getTime() <= args.where.nextAttemptAt.lte.getTime(),
          )
          .slice(0, args.take)
          .map((row) => ({ id: row.id, channelId: row.channelId }));
      },
      async findUnique(args: {
        where:
          | { id: string }
          | { notificationId_channelId: { notificationId: string; channelId: string } };
      }) {
        if ('notificationId_channelId' in args.where) {
          return rows.get(key(
            args.where.notificationId_channelId.notificationId,
            args.where.notificationId_channelId.channelId,
          )) ?? null;
        }
        const id = (args.where as { id: string }).id;
        return [...rows.values()].find((row) => row.id === id) ?? null;
      },
      async updateMany(args: {
        where: { id: string; status?: string; nextAttemptAt?: { lte: Date } };
        data: { attempts?: { increment: number }; nextAttemptAt?: Date } & Partial<DeliveryRow>;
      }) {
        const row = [...rows.values()].find((r) => r.id === args.where.id);
        if (!row) return { count: 0 };
        if (args.where.status && row.status !== args.where.status) return { count: 0 };
        if (
          args.where.nextAttemptAt &&
          row.nextAttemptAt.getTime() > args.where.nextAttemptAt.lte.getTime()
        ) {
          return { count: 0 };
        }
        if (args.data.attempts) row.attempts += args.data.attempts.increment;
        if (args.data.nextAttemptAt) row.nextAttemptAt = args.data.nextAttemptAt;
        if (typeof args.data.status === 'string') row.status = args.data.status;
        if (args.data.lastError !== undefined) row.lastError = args.data.lastError;
        return { count: 1 };
      },
      async update(args: { where: { id: string }; data: Partial<DeliveryRow> }) {
        const row = [...rows.values()].find((r) => r.id === args.where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, args.data);
        return row;
      },
      async count(args: { where: { status: string } }) {
        return [...rows.values()].filter((row) => row.status === args.where.status).length;
      },
    },
  };
}

const VIEW: NotificationView = {
  id: 'n1',
  type: 'order.paid',
  title: '支付成功',
  body: 'b',
  link: '/account/orders',
  data: { orderId: 'o1' },
  status: 'success',
  progress: null,
  readAt: null,
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
};

function makeDispatcher(
  channels: NotificationChannel[],
  overrides: {
    maxAttempts?: number;
    policy?: Partial<NotificationPolicyService>;
  } = {},
) {
  const db = createFakeDb();
  const events: EventBus = {
    publish: () => {},
    subscribe: () => () => {},
    intercept: () => () => {},
    waterfall: <T>(_t: string, value: T): T => value,
  };
  const dispatcher = new NotificationDispatcher({
    db: db as never,
    events,
    getChannels: () => channels,
    logger: { warn: () => {} },
    ...overrides,
  } as NotificationDispatcherOptions);
  return { dispatcher, db };
}

describe('NotificationDispatcher', () => {
  it('fans a notification out to every wanting channel and records one delivery each', async () => {
    const delivered: string[] = [];
    const email: NotificationChannel = {
      id: 'email',
      name: '邮件',
      deliver: async (d) => {
        delivered.push(`email:${d.notificationId}`);
      },
    };
    const webhook: NotificationChannel = {
      id: 'webhook',
      name: 'Webhook',
      deliver: async (d) => {
        delivered.push(`webhook:${d.notificationId}`);
      },
    };
    const { dispatcher, db } = makeDispatcher([email, webhook]);

    const count = await dispatcher.dispatch(VIEW, 'user-1');

    expect(count).toBe(2);
    expect(delivered.sort()).toEqual(['email:n1', 'webhook:n1']);
    expect([...db.rows.values()]).toHaveLength(2);
    expect([...db.rows.values()].every((row) => row.status === 'DELIVERED')).toBe(true);
  });

  it('honors channel wants() and never invokes a channel that declines', async () => {
    const email = vi.fn(async () => {});
    const channel: NotificationChannel = {
      id: 'email',
      name: '邮件',
      wants: (d: NotificationDispatch) => d.type === 'order.paid',
      deliver: email,
    };
    const { dispatcher, db } = makeDispatcher([channel]);

    await dispatcher.dispatch({ ...VIEW, type: 'service.expiring' }, 'user-1');

    expect(email).not.toHaveBeenCalled();
    expect([...db.rows.values()]).toHaveLength(0);
  });

  it('records a PENDING row and stays retryable when deliver() throws', async () => {
    const deliver = vi.fn(async () => {
      throw new Error('smtp down');
    });
    const { dispatcher, db } = makeDispatcher([{ id: 'email', name: '邮件', deliver }], {
      maxAttempts: 3,
    });

    await dispatcher.dispatch(VIEW, 'user-1');

    const row = [...db.rows.values()][0]!;
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('smtp down');
  });

  it('marks a delivery FAILED (dead letter) once attempts reach the ceiling', async () => {
    const deliver = vi.fn(async () => {
      throw new Error('smtp down');
    });
    const { dispatcher, db } = makeDispatcher([{ id: 'email', name: '邮件', deliver }], {
      maxAttempts: 2,
    });

    await dispatcher.dispatch(VIEW, 'user-1'); // attempt 1 → PENDING
    // Force due now so the sweep retries immediately.
    const row = [...db.rows.values()][0]!;
    row.nextAttemptAt = new Date(0);
    await dispatcher.sweep(); // attempt 2 → FAILED

    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(2);
  });

  it('sweep retries a due PENDING delivery and marks it DELIVERED on success', async () => {
    let fail = true;
    const deliver = vi.fn(async () => {
      if (fail) throw new Error('smtp down');
    });
    const { dispatcher, db } = makeDispatcher([{ id: 'email', name: '邮件', deliver }]);

    await dispatcher.dispatch(VIEW, 'user-1');
    const row = [...db.rows.values()][0]!;
    expect(row.status).toBe('PENDING');

    fail = false;
    row.nextAttemptAt = new Date(0);
    await dispatcher.sweep();

    expect(row.status).toBe('DELIVERED');
    expect(row.deliveredAt).toBeInstanceOf(Date);
  });

  it('is idempotent by (notification, channel): replay merges into one row', async () => {
    let calls = 0;
    const { dispatcher, db } = makeDispatcher([
      {
        id: 'email',
        name: '邮件',
        deliver: async () => {
          calls += 1;
        },
      },
    ]);

    await dispatcher.dispatch(VIEW, 'user-1');
    await dispatcher.dispatch(VIEW, 'user-1');

    // An identical replay is a no-op (audit F-2: the old upsert reset a
    // DELIVERED row to PENDING and re-sent the email). The row is delivered
    // once; a *changed* payload re-arms (covered below).
    expect(calls).toBe(1);
    expect([...db.rows.values()]).toHaveLength(1);
    expect([...db.rows.values()][0]!.status).toBe('DELIVERED');
  });

  it('sweep marks a delivery FAILED when its channel plugin is gone', async () => {
    const { dispatcher, db } = makeDispatcher([
      { id: 'email', name: '邮件', deliver: async () => {} },
    ]);
    await dispatcher.dispatch(VIEW, 'user-1');
    const row = [...db.rows.values()][0]!;
    row.nextAttemptAt = new Date(0);
    row.status = 'PENDING';

    // Now the channel is unregistered before the retry.
    (
      dispatcher as unknown as { options: { getChannels: () => NotificationChannel[] } }
    ).options.getChannels = () => [];
    await dispatcher.sweep();

    expect(row.status).toBe('FAILED');
    expect(row.lastError).toContain('email');
  });

  it('does nothing when no channels are registered', async () => {
    const { dispatcher, db } = makeDispatcher([]);
    const count = await dispatcher.dispatch(VIEW, 'user-1');
    expect(count).toBe(0);
    expect([...db.rows.values()]).toHaveLength(0);
  });

  it('skips a channel the recipient disabled via the policy service', async () => {
    const deliver = vi.fn(async () => {});
    const { dispatcher, db } = makeDispatcher([{ id: 'email', name: '邮件', deliver }], {
      policy: { isEnabled: async () => false },
    });

    const count = await dispatcher.dispatch(VIEW, 'user-1');

    expect(count).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect([...db.rows.values()]).toHaveLength(0);
  });

  it('delivers when the policy service reports the channel enabled', async () => {
    const deliver = vi.fn(async () => {});
    const { dispatcher } = makeDispatcher([{ id: 'email', name: '邮件', deliver }], {
      policy: { isEnabled: async () => true },
    });

    const count = await dispatcher.dispatch(VIEW, 'user-1');

    expect(count).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('stops an already-pending delivery when the user disables it before the sweep', async () => {
    let enabled = true;
    const deliver = vi.fn(async () => {
      throw new Error('smtp down');
    });
    const { dispatcher, db } = makeDispatcher([{ id: 'email', name: '邮件', deliver }], {
      policy: { isEnabled: async () => enabled },
    });

    await dispatcher.dispatch(VIEW, 'user-1'); // PENDING after failure
    const row = [...db.rows.values()][0]!;
    expect(row.status).toBe('PENDING');

    // User disables the channel, then the sweep comes due.
    enabled = false;
    row.nextAttemptAt = new Date(0);
    await dispatcher.sweep();

    expect(row.status).toBe('FAILED');
    expect(deliver).toHaveBeenCalledTimes(1); // no second delivery attempt
  });

  it('fails open when the policy service throws (never silently drops)', async () => {
    const deliver = vi.fn(async () => {});
    const { dispatcher } = makeDispatcher([{ id: 'email', name: '邮件', deliver }], {
      policy: {
        isEnabled: async () => {
          throw new Error('policy db down');
        },
      },
    });

    const count = await dispatcher.dispatch(VIEW, 'user-1');

    expect(count).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('does not re-send a DELIVERED notification when the same content is replayed', async () => {
    const deliver = vi.fn(async () => {});
    const { dispatcher, db } = makeDispatcher([{ id: 'email', name: '邮件', deliver }]);

    await dispatcher.dispatch(VIEW, 'user-1');
    const row = [...db.rows.values()][0]!;
    expect(row.status).toBe('DELIVERED');
    expect(deliver).toHaveBeenCalledTimes(1);

    // at-least-once replay (relay redelivery / replica catch-up): same payload.
    await dispatcher.dispatch(VIEW, 'user-1');

    expect(row.status).toBe('DELIVERED');
    expect(deliver).toHaveBeenCalledTimes(1); // no duplicate email
  });

  it('re-arms delivery when a replayed notification actually changed', async () => {
    const deliver = vi.fn(async () => {});
    const { dispatcher, db } = makeDispatcher([{ id: 'email', name: '邮件', deliver }]);

    await dispatcher.dispatch(VIEW, 'user-1');
    const row = [...db.rows.values()][0]!;
    expect(deliver).toHaveBeenCalledTimes(1);

    // Same event id but the body changed (notification upsert): deliver again.
    await dispatcher.dispatch({ ...VIEW, body: '新的正文' }, 'user-1');

    expect(deliver).toHaveBeenCalledTimes(2);
    expect((row.payload as { body: string }).body).toBe('新的正文');
  });

  it('dedupes a duplicate outbox event via eventId (runIdempotent)', async () => {
    const deliver = vi.fn(async () => {});
    const seen = new Set<string>();
    const events: EventBus = {
      publish: () => {},
      subscribe: () => () => {},
      intercept: () => () => {},
      waterfall: <T>(_t: string, value: T): T => value,
      runIdempotent: async (_consumer: string, eventId: string, handler) => {
        if (seen.has(eventId)) return false;
        seen.add(eventId);
        await handler();
        return true;
      },
    };
    const db = createFakeDb();
    const dispatcher = new NotificationDispatcher({
      db: db as never,
      events,
      getChannels: () => [{ id: 'email', name: '邮件', deliver }],
      logger: { warn: () => {} },
    } as NotificationDispatcherOptions);

    // Subscribe through the real `start()` wiring so the meta path is exercised.
    let handler: ((payload: unknown, meta?: { eventId: string; topic: string }) => void) | null =
      null;
    events.subscribe = ((_topic: string, fn: typeof handler) => {
      handler = fn;
      return () => {};
    }) as EventBus['subscribe'];
    dispatcher.start();

    const payload = { notification: VIEW, userId: 'user-1' };
    handler!(payload, { eventId: 'evt-1', topic: 'notification.created' });
    // Duplicate delivery of the same event id must be skipped.
    handler!(payload, { eventId: 'evt-1', topic: 'notification.created' });
    // `start()` dispatches fire-and-forget; let both run.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
