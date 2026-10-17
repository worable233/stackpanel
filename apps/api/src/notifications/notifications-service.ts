import { Prisma } from '@stackpanel/db';
import type { PrismaClient } from '@stackpanel/db';
import type {
  CreateNotificationInput,
  EventBus,
  NotificationListResult,
  NotificationPolicyService,
  NotificationStatus,
  NotificationView,
  NotificationsService,
  UpsertNotificationInput,
} from '@stackpanel/sdk';
import { outboxOrigin, serializeOutboxBody } from '../plugins/events.ts';

export interface NotificationsServiceOptions {
  db: PrismaClient;
  events: EventBus;
  /**
   * Two-level preference engine. When present, the in-app read APIs
   * (`listForUser`/`unreadCount`) hide types the user disabled on the `inapp`
   * channel. Writing a notification is never gated — an undeclared type or a
   * disabled in-app copy still lands in the DB; only the read surface filters.
   */
  policy?: NotificationPolicyService;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const STATUSES: readonly NotificationStatus[] = ['info', 'active', 'success', 'error'];

/** A transaction-scoped client that can write the event and the notification. */
type TxClient = Pick<PrismaClient, 'notification' | 'outboxEvent'>;

/**
 * True when the bound bus persists to the outbox. Only then can the event be
 * written atomically with the notification row; the in-process dev/test bus has
 * no outbox and is delivered directly after the write.
 */
function usesOutbox(events: EventBus): boolean {
  return typeof (events as { nudgeRelay?: unknown }).nudgeRelay === 'function';
}

/**
 * Register a notification event inside an existing transaction (W1), so the
 * domain event is durable iff the notification row commits.
 */
async function enqueueNotificationEvent(
  tx: TxClient,
  topic: 'notification.created' | 'notification.updated',
  userId: string,
  view: NotificationView,
): Promise<void> {
  const payload = { notification: view, userId };
  await tx.outboxEvent.create({
    data: {
      topic,
      payload: { body: serializeOutboxBody(topic, payload, outboxOrigin()) },
      origin: outboxOrigin(),
    },
  });
}

/** Nudge the durable relay after a transactional publish (no inline delivery). */
function nudgeOutbox(events: EventBus): void {
  (events as { nudgeRelay?: () => void }).nudgeRelay?.();
}

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
    const data = {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      data: (input.data ?? Prisma.DbNull) as
        Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
      status: normalizeStatus(input.status),
      progress: normalizeProgress(input.progress),
    };
    if (!usesOutbox(this.options.events)) {
      // In-process bus (dev/tests): no outbox to be atomic with.
      const row = await this.options.db.notification.create({ data });
      const directView = this.toView(row);
      this.options.events.publish('notification.created', {
        notification: directView,
        userId: input.userId,
      });
      return directView;
    }
    // W1: the notification row and its `notification.created` event commit in
    // the same transaction, so a crash between them cannot lose the event.
    const view = await this.options.db.$transaction(async (tx) => {
      const created = await tx.notification.create({ data });
      const createdView = this.toView(created);
      await enqueueNotificationEvent(tx, 'notification.created', input.userId, createdView);
      return createdView;
    });
    nudgeOutbox(this.options.events);
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
      data: (input.data ?? Prisma.DbNull) as
        Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput,
      status: normalizeStatus(input.status),
      progress: normalizeProgress(input.progress),
      readAt: null,
    };
    if (!usesOutbox(this.options.events)) {
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
          if ((error as { code?: string }).code === 'P2002') {
            row = await this.options.db.notification.update({
              where: { userId_dedupeKey: key },
              data,
            });
          } else {
            throw error;
          }
        }
      }
      const directView = this.toView(row);
      this.options.events.publish(created ? 'notification.created' : 'notification.updated', {
        notification: directView,
        userId: input.userId,
      });
      return directView;
    }
    // W1: rewrite + event in one transaction. The create-vs-update decision is
    // made inside the same transaction so the choice and the row agree.
    const result = await this.options.db.$transaction(async (tx) => {
      const existing = await tx.notification.findUnique({
        where: { userId_dedupeKey: key },
        select: { id: true },
      });
      let created = false;
      let row;
      if (existing) {
        row = await tx.notification.update({ where: { userId_dedupeKey: key }, data });
      } else {
        try {
          row = await tx.notification.create({ data: { ...key, ...data } });
          created = true;
        } catch (error) {
          // A concurrent first-write won the create; retry as an update.
          if ((error as { code?: string }).code === 'P2002') {
            row = await tx.notification.update({
              where: { userId_dedupeKey: key },
              data,
            });
          } else {
            throw error;
          }
        }
      }
      const view = this.toView(row);
      await enqueueNotificationEvent(
        tx,
        created ? 'notification.created' : 'notification.updated',
        input.userId,
        view,
      );
      return view;
    });
    nudgeOutbox(this.options.events);
    return result;
  }

  private excludeFilter(
    exclusions: { exact: string[]; prefixes: string[] } | null,
  ): Prisma.NotificationWhereInput {
    if (!exclusions) return {};
    const clauses: Prisma.NotificationWhereInput[] = [];
    if (exclusions.exact.length > 0) clauses.push({ type: { notIn: exclusions.exact } });
    if (exclusions.prefixes.length > 0) {
      clauses.push({
        NOT: { OR: exclusions.prefixes.map((prefix) => ({ type: { startsWith: prefix } })) },
      });
    }
    return clauses.length > 0 ? { AND: clauses } : {};
  }

  /** In-app exclusion filter for this user; `{}` when nothing is disabled. */
  private async exclusionFilter(userId: string): Promise<Prisma.NotificationWhereInput> {
    const policy = this.options.policy;
    if (!policy) return {};
    try {
      return this.excludeFilter(await policy.inAppExclusions(userId));
    } catch {
      // 偏好查询失败时宁多勿少：不过滤，绝不因偏好故障而漏掉用户通知。
      return {};
    }
  }

  async listForUser(
    userId: string,
    options: { limit?: number; cursor?: string; unreadOnly?: boolean } = {},
  ): Promise<NotificationListResult> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const exclusions = await this.exclusionFilter(userId);
    const where = {
      userId,
      ...exclusions,
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
      where: { userId, ...exclusions, readAt: null },
    });
    return {
      items: page.map((row) => this.toView(row)),
      unreadCount,
      nextCursor: hasMore && lastRow ? lastRow.id : null,
    };
  }

  async unreadCount(userId: string): Promise<number> {
    const exclusions = await this.exclusionFilter(userId);
    return this.options.db.notification.count({ where: { userId, ...exclusions, readAt: null } });
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

  async notifyPermissionHolders(
    permission: string,
    input: Omit<CreateNotificationInput, 'userId'>,
  ): Promise<number> {
    // Resolve recipients from the kernel's own RBAC tables: every ACTIVE user
    // whose groups grant `permission`. The plugin supplies only the permission
    // key, so recipient authorization never leaves the kernel boundary.
    const holders = await this.options.db.user.findMany({
      where: {
        status: 'ACTIVE',
        groups: { some: { group: { permissions: { some: { permission: { key: permission } } } } } },
      },
      select: { id: true },
    });
    let notified = 0;
    for (const holder of holders) {
      try {
        await this.create({ ...input, userId: holder.id });
        notified += 1;
      } catch {
        // A single failing recipient must not abort the fan-out.
      }
    }
    return notified;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    notifications: KernelNotificationsService;
  }
}
