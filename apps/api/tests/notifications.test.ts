import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@stackpanel/db';
import { EventEmitterEventBus } from '../src/plugins/events.ts';
import { KernelNotificationsService } from '../src/notifications/notifications-service.ts';

/** 最小内存版 Prisma-like client，覆盖 notifications 用到的模型与方法。 */
function createFakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  let seq = 0;

  const matchesWhere = (row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.readAt !== undefined && where.readAt === null && row.readAt !== null) return false;
    if ('userId_dedupeKey' in where) {
      const key = where.userId_dedupeKey as { userId?: string; dedupeKey?: string };
      if (key.userId !== undefined && row.userId !== key.userId) return false;
      if (key.dedupeKey !== undefined && row.dedupeKey !== key.dedupeKey) return false;
    }
    return true;
  };

  const stamp = (row: Record<string, unknown>): Record<string, unknown> => {
    const now = new Date();
    return { id: `ntf-${++seq}`, readAt: null, status: 'info', progress: null, createdAt: now, updatedAt: now, ...row };
  };

  const api = {
    notification: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = stamp(data);
        rows.push(row);
        return row;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const row = rows.find((candidate) => matchesWhere(candidate, where));
          if (!row) throw new Error('not found');
          for (const [key, value] of Object.entries(data)) row[key] = value;
          row.updatedAt = new Date(row.updatedAt as Date);
          return row;
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return rows.find((candidate) => matchesWhere(candidate, where)) ?? null;
      }),
      findMany: vi.fn(
        async ({
          where = {},
          take,
          cursor,
          skip = 0,
        }: {
          where?: Record<string, unknown>;
          take?: number;
          cursor?: string | { id: string };
          skip?: number;
        }) => {
          let list = rows.filter((row) => matchesWhere(row, where)).sort((a, b) => {
            const created = Number(b.createdAt) - Number(a.createdAt);
            if (created !== 0) return created;
            return String(b.id).localeCompare(String(a.id));
          });
          const cursorId = typeof cursor === 'string' ? cursor : (cursor as { id?: string })?.id;
          if (cursorId) {
            const index = list.findIndex((row) => row.id === cursorId);
            list = index >= 0 ? list.slice(index + 1) : [];
          } else if (skip > 0) {
            list = list.slice(skip);
          }
          if (take !== undefined) list = list.slice(0, take);
          return list;
        },
      ),
      count: vi.fn(
        async ({ where }: { where?: Record<string, unknown> }) =>
          rows.filter((row) => matchesWhere(row, where)).length,
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const matched = rows.filter((row) => matchesWhere(row, where));
          for (const row of matched) {
            for (const [key, value] of Object.entries(data)) row[key] = value;
          }
          return { count: matched.length };
        },
      ),
    },
  };
  return { api, rows };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('KernelNotificationsService', () => {
  let db: ReturnType<typeof createFakeDb>;
  let events: EventEmitterEventBus;
  let service: KernelNotificationsService;

  beforeEach(() => {
    db = createFakeDb();
    events = new EventEmitterEventBus();
    service = new KernelNotificationsService({
      db: db.api as unknown as PrismaClient,
      events,
    });
  });

  it('creates a notification and publishes the notification.created event', async () => {
    const seen: unknown[] = [];
    events.subscribe('notification.created', (payload) => seen.push(payload));

    const view = await service.create({
      userId: 'user-1',
      type: 'order.paid',
      title: '订单已支付',
      body: '订单 #1001 已支付成功',
      link: '/account/orders/1001',
      data: { orderId: '1001' },
    });

    expect(view.id).toBe('ntf-1');
    expect(view.type).toBe('order.paid');
    expect(view.title).toBe('订单已支付');
    expect(view.body).toBe('订单 #1001 已支付成功');
    expect(view.link).toBe('/account/orders/1001');
    expect(view.data).toEqual({ orderId: '1001' });
    expect(view.readAt).toBeNull();
    expect(typeof view.createdAt).toBe('string');
    expect(seen).toHaveLength(1);
    expect((seen[0] as { notification: unknown }).notification).toEqual(view);
  });

  it('upserting a live notification advances the same row in place', async () => {
    const created = await service.upsert({
      userId: 'user-1',
      dedupeKey: 'frontend-apply',
      type: 'system.frontend-apply',
      title: '安装中：插件「A」',
      body: '第 1/4 步',
      status: 'active',
      progress: 25,
    });
    expect(created.status).toBe('active');
    expect(created.progress).toBe(25);
    expect(db.rows).toHaveLength(1);

    const updated = await service.upsert({
      userId: 'user-1',
      dedupeKey: 'frontend-apply',
      type: 'system.frontend-apply',
      title: '插件「A」安装完成',
      status: 'success',
      progress: 100,
    });
    // Same row, rewritten.
    expect(updated.id).toBe(created.id);
    expect(db.rows).toHaveLength(1);
    expect(updated.title).toBe('插件「A」安装完成');
    expect(updated.status).toBe('success');
    expect(updated.progress).toBe(100);
  });

  it('upserting re-surfaces a read activity as unread and publishes updated', async () => {
    const events_: unknown[] = [];
    events.subscribe('notification.updated', (payload) => events_.push(payload));
    const created = await service.upsert({
      userId: 'user-1',
      dedupeKey: 'job',
      type: 'system.job',
      title: '进行中',
      status: 'active',
      progress: 10,
    });
    await service.markRead('user-1', created.id);
    expect(await service.unreadCount('user-1')).toBe(0);

    const advanced = await service.upsert({
      userId: 'user-1',
      dedupeKey: 'job',
      type: 'system.job',
      title: '进行中',
      status: 'active',
      progress: 50,
    });
    expect(advanced.readAt).toBeNull();
    expect(await service.unreadCount('user-1')).toBe(1);
    expect(events_).toHaveLength(1);
  });

  it('upsert is scoped per user for the same dedupe key', async () => {
    const a = await service.upsert({
      userId: 'user-1',
      dedupeKey: 'k',
      type: 't',
      title: '甲',
    });
    const b = await service.upsert({
      userId: 'user-2',
      dedupeKey: 'k',
      type: 't',
      title: '乙',
    });
    expect(a.id).not.toBe(b.id);
    expect(db.rows).toHaveLength(2);
  });

  it('lists newest first with an unread count', async () => {
    await service.create({ userId: 'user-1', type: 'a', title: '第一' });
    await service.create({ userId: 'user-1', type: 'b', title: '第二' });

    const result = await service.listForUser('user-1');
    expect(result.items.map((item) => item.title)).toEqual(['第二', '第一']);
    expect(result.unreadCount).toBe(2);
    expect(result.nextCursor).toBeNull();
  });

  it('paginates with an opaque cursor and applies the unreadOnly filter', async () => {
    await service.create({ userId: 'user-1', type: 'a', title: '未读一' });
    await service.create({ userId: 'user-1', type: 'b', title: '未读二' });
    await service.create({ userId: 'user-1', type: 'c', title: '未读三' });
    const initial = await service.listForUser('user-1');
    const firstItem = initial.items[0];
    if (!firstItem) throw new Error('缺少通知');
    await service.markRead('user-1', firstItem.id);

    const first = await service.listForUser('user-1', { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    expect(first.unreadCount).toBe(2);

    const cursor = first.nextCursor;
    if (!cursor) throw new Error('缺少分页游标');
    const second = await service.listForUser('user-1', { limit: 2, cursor });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const unread = await service.listForUser('user-1', { unreadOnly: true });
    expect(unread.items).toHaveLength(2);
    expect(unread.unreadCount).toBe(2);
  });

  it('scopes everything to the owning user', async () => {
    await service.create({ userId: 'user-1', type: 'a', title: '自己' });
    await service.create({ userId: 'user-2', type: 'a', title: '别人' });

    const own = await service.listForUser('user-1');
    expect(own.items.map((item) => item.title)).toEqual(['自己']);
    expect(own.unreadCount).toBe(1);

    const other = await service.unreadCount('user-2');
    expect(other).toBe(1);
  });

  it('marks a single notification read and reports unknown ids as false', async () => {
    const created = await service.create({ userId: 'user-1', type: 'a', title: '待读' });

    const missing = await service.markRead('user-1', 'does-not-exist');
    expect(missing).toBe(false);

    const crossUser = await service.markRead('user-2', created.id);
    expect(crossUser).toBe(false);
    expect(await service.unreadCount('user-1')).toBe(1);

    const marked = await service.markRead('user-1', created.id);
    expect(marked).toBe(true);
    expect(await service.unreadCount('user-1')).toBe(0);

    const again = await service.markRead('user-1', created.id);
    expect(again).toBe(false);
  });

  it('marks all read and returns the updated count', async () => {
    await service.create({ userId: 'user-1', type: 'a', title: '一' });
    await service.create({ userId: 'user-1', type: 'a', title: '二' });

    const count = await service.markAllRead('user-1');
    expect(count).toBe(2);
    expect(await service.unreadCount('user-1')).toBe(0);
    expect(await service.markAllRead('user-1')).toBe(0);
  });

  it('is exposed on the plugin context via the runtime', async () => {
    const { PluginRuntime } = await import('../src/plugins/runtime.ts');
    const routes: unknown[] = [];
    const runtime = new PluginRuntime({
      events,
      logger: silentLogger,
      db: db.api,
      extensions: {
        registerModels: async () => undefined,
        unregisterModels: () => undefined,
        applyRetention: async () => undefined,
        client: () => ({}) as never,
        clientWith: () => ({}) as never,
      },
      registerRoute: (id, route) => {
        routes.push({ id, route });
        return () => undefined;
      },
      removeRoutes: () => undefined,
      payments: {} as never,
      wallet: {} as never,
      fx: {} as never,
      auth: {} as never,
      notifications: service,
      state: {} as never,
      jobs: {} as never,
    });
    const { definePlugin } = await import('@stackpanel/sdk');
    let exposed: unknown;
    await runtime.register(
      definePlugin({
        manifest: { id: 'probe', name: 'Probe', version: '1.0.0' },
        onActivate: (ctx) => {
          exposed = ctx.notifications;
        },
      }),
    );
    await runtime.activate('probe');
    expect(exposed).toBe(service);
  });
});
