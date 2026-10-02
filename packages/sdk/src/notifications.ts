/**
 * In-app notification primitives shared by the kernel, plugins, and the web BFF.
 *
 * The notification system is a platform base capability: the kernel owns the
 * `Notification` table, the read/unread APIs, and the top-bar bell. Plugins
 * write notifications through {@link PluginContext.notifications} without
 * depending on any specific plugin being active.
 */

/** A single in-app notification row as exposed to clients and plugins. */
export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
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
