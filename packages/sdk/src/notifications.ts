/**
 * In-app notification primitives shared by the kernel, plugins, and the web BFF.
 *
 * The notification system is a platform base capability: the kernel owns the
 * `Notification` table, the read/unread APIs, and the top-bar bell. Plugins
 * write notifications through {@link PluginContext.notifications} without
 * depending on any specific plugin being active.
 */

/**
 * Lifecycle of a notification. `info` is a plain one-shot message (the
 * historical behaviour). `active` marks an *ongoing activity* whose
 * title/body/progress are updated in place until it settles as `success` or
 * `error` — the "live notification" model (e.g. a front-end apply).
 */
export type NotificationStatus = 'info' | 'active' | 'success' | 'error';

/** A single in-app notification row as exposed to clients and plugins. */
export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  data: Record<string, unknown> | null;
  status: NotificationStatus;
  /** 0–100 while `active`; `null` when the notification carries no progress. */
  progress: number | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input to create a notification for a user. */
export interface CreateNotificationInput {
  /** Target user's id. */
  userId: string;
  /** Notification kind, e.g. `order.paid` / `delivery.failed` / `announcement`. */
  type: string;
  title: string;
  body?: string;
  /** Frontend deep link, e.g. `/account/orders/:id`. */
  link?: string;
  /** Plugin-defined payload; never contains secrets. */
  data?: Record<string, unknown>;
  /** Defaults to `info`. Use `active` for an ongoing activity. */
  status?: NotificationStatus;
  /** 0–100 progress for an `active` activity. */
  progress?: number;
  /**
   * Stable identity for an updatable notification. When set, `upsert` finds the
   * user's notification with the same key and rewrites it in place instead of
   * appending a new row. Ignored by `create`.
   */
  dedupeKey?: string;
}

/**
 * Input to {@link NotificationsService.upsert}. `dedupeKey` is required: it is
 * the identity that turns a sequence of progress updates into one live row.
 */
export interface UpsertNotificationInput extends CreateNotificationInput {
  dedupeKey: string;
}

/** Paginated result of listing a user's notifications. */
export interface NotificationListResult {
  items: NotificationView[];
  unreadCount: number;
  /** Opaque cursor for the next page; `null` when the end is reached. */
  nextCursor: string | null;
}

/**
 * Kernel-owned notification service exposed to plugins via
 * `ctx.notifications` and used internally by the kernel routes.
 */
export interface NotificationsService {
  create(input: CreateNotificationInput): Promise<NotificationView>;
  /**
   * Create, or rewrite in place, the notification identified by
   * `(userId, dedupeKey)`. Used for live activities: the same row advances
   * through `active` → `success`/`error`. An update clears `readAt` so the
   * activity re-surfaces while it is in progress.
   */
  upsert(input: UpsertNotificationInput): Promise<NotificationView>;
  listForUser(
    userId: string,
    options?: { limit?: number; cursor?: string; unreadOnly?: boolean },
  ): Promise<NotificationListResult>;
  unreadCount(userId: string): Promise<number>;
  /** Mark one of the user's notifications as read. Returns false when not found. */
  markRead(userId: string, notificationId: string): Promise<boolean>;
  /** Mark every unread notification of the user as read. Returns the count updated. */
  markAllRead(userId: string): Promise<number>;
}
