import { Prisma } from '@stackpanel/db';
import type { PrismaClient } from '@stackpanel/db';
import type {
  CreateNotificationInput,
  EventBus,
  NotificationListResult,
  NotificationStatus,
  NotificationView,
  NotificationsService,
  UpsertNotificationInput,
} from '@stackpanel/sdk';

export interface NotificationsServiceOptions {
  db: PrismaClient;
  events: EventBus;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const STATUSES: readonly NotificationStatus[] = ['info', 'active', 'success', 'error'];

function normalizeStatus(value: unknown): NotificationStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? (value as NotificationStatus)
    : 'info';
}

function normalizeProgress(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.round(value), 0), 100);
}

/**
 * Kernel-owned in-app notification service. Owns the `notifications` table and
 * the read/unread APIs. After a notification is created it publishes the
 * `notification.created` event; an in-place rewrite publishes
 * `notification.updated`, so external channel plugins (email/webhook/push, the
 * reserved `notification.channel` extension point) can forward either.
 */
export class KernelNotificationsService implements NotificationsService {
  constructor(private readonly options: NotificationsServiceOptions) {}

  private toView(row: {
    id: string;
    type: string;
    title: string;
    body: string | null;
    link: string | null;
    data: unknown;
    status: string;
    progress: number | null;
    readAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): NotificationView {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      link: row.link,
      data: (row.data as Record<string, unknown> | null) ?? null,
      status: normalizeStatus(row.status),
      progress: row.progress,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async create(input: CreateNotificationInput): Promise<NotificationView> {
    const row = await this.options.db.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        data: (input.data ?? Prisma.DbNull) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
        status: normalizeStatus(input.status),
        progress: normalizeProgress(input.progress),
      },
    });
    const view = this.toView(row);
    this.options.events.publish('notification.created', {
      notification: view,
      userId: input.userId,
    });
    return view;
  }

  async upsert(input: UpsertNotificationInput): Promise<NotificationView> {
    const key = { userId: input.userId, dedupeKey: input.dedupeKey };
    // A read activity that advances must re-surface as unread; each rewrite
    // clears `readAt`. This is also what makes the bell badge track progress.
    const data = {
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      data: (input.data ?? Prisma.DbNull) as Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
      status: normalizeStatus(input.status),
      progress: normalizeProgress(input.progress),
      readAt: null,
    };
    const existing = await this.options.db.notification.findUnique({
      where: { userId_dedupeKey: key },
      select: { id: true },
    });
    let created = false;
    let row;
    if (existing) {
      row = await this.options.db.notification.update({ where: { userId_dedupeKey: key }, data });
    } else {
      try {
        row = await this.options.db.notification.create({ data: { ...key, ...data } });
        created = true;
      } catch (error) {
        // A concurrent first-write won the create; retry as an update.
        if ((error as { code?: string }).code === 'P2002') {
          row = await this.options.db.notification.update({ where: { userId_dedupeKey: key }, data });
        } else {
          throw error;
        }
      }
    }
    const view = this.toView(row);
    this.options.events.publish(created ? 'notification.created' : 'notification.updated', {
      notification: view,
      userId: input.userId,
    });
    return view;
  }

  async listForUser(
    userId: string,
    options: { limit?: number; cursor?: string; unreadOnly?: boolean } = {},
  ): Promise<NotificationListResult> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const where = {
      userId,
      ...(options.unreadOnly ? { readAt: null } : {}),
    };
    const rows = await this.options.db.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page.at(-1);
    const unreadCount = await this.options.db.notification.count({
      where: { userId, readAt: null },
    });
    return {
      items: page.map((row) => this.toView(row)),
      unreadCount,
      nextCursor: hasMore && lastRow ? lastRow.id : null,
    };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.options.db.notification.count({ where: { userId, readAt: null } });
  }

  async markRead(userId: string, notificationId: string): Promise<boolean> {
    const result = await this.options.db.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count > 0;
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await this.options.db.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    notifications: KernelNotificationsService;
  }
}
