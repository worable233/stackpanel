import { Prisma } from '@stackpanel/db';
import type { PrismaClient } from '@stackpanel/db';
import type {
  CreateNotificationInput,
  EventBus,
  NotificationListResult,
  NotificationView,
  NotificationsService,
} from '@stackpanel/sdk';

export interface NotificationsServiceOptions {
  db: PrismaClient;
  events: EventBus;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/**
 * Kernel-owned in-app notification service. Owns the `notifications` table and
 * the read/unread APIs. After a notification is created it publishes the
 * `notification.created` event so external channel plugins (email/webhook/push,
 * the reserved `notification.channel` extension point) can forward it.
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
    readAt: Date | null;
    createdAt: Date;
  }): NotificationView {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      link: row.link,
      data: (row.data as Record<string, unknown> | null) ?? null,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
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
      },
    });
    const view = this.toView(row);
    this.options.events.publish('notification.created', { notification: view });
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
