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
  /**
   * Fan a one-shot notification out to every **active** holder of a permission
   * (recipient authorization stays kernel-owned: a plugin names the permission,
   * the kernel resolves who currently holds it). Returns the number of users
   * notified. Failures for individual users are skipped, not fatal.
   */
  notifyPermissionHolders(
    permission: string,
    input: Omit<CreateNotificationInput, 'userId'>,
  ): Promise<number>;
}

/**
 * A notification as handed to an external channel (email/webhook/push). It is a
 * flat, JSON-safe projection of a {@link NotificationView} plus its owner, so a
 * channel never needs kernel DB access.
 */
export interface NotificationDispatch {
  /** Stable id of the source notification (idempotency anchor). */
  notificationId: string;
  /** Notification owner. */
  userId: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  data: Record<string, unknown> | null;
  status: NotificationStatus;
  progress: number | null;
  createdAt: string;
}

/**
 * An external notification channel supplied by a plugin and registered on the
 * `notification.channel` extension point. The kernel owns recipient
 * authorization, durable delivery records, idempotency keys, retry/backoff and
 * failure replay; the channel only performs delivery.
 *
 * Contract: `deliver` resolves on success and **throws** on a transient failure
 * (the kernel retries with exponential backoff). Returning without throwing
 * means "delivered" — a channel must not swallow an error it wants retried.
 */
export interface NotificationChannel {
  readonly id: string;
  readonly name: string;
  /**
   * Whether this channel handles the given notification (type preference /
   * user opt-out). Defaults to handling everything when omitted. A channel is
   * only invoked for a notification it *wants*.
   *
   * NOTE: this is the *channel's own* filter (e.g. skipping high-frequency
   * progress types). The per-user/admin opt-out is owned by the kernel
   * (`NotificationPolicyService`) and applied before `wants` is consulted.
   */
  wants?(dispatch: NotificationDispatch): boolean | Promise<boolean>;
  /** Deliver one notification. Throw to request a retry. */
  deliver(dispatch: NotificationDispatch): Promise<void>;
}

/* --------------------------- 通知类型目录与偏好 --------------------------- */

/**
 * Synthetic channel id for the in-app inbox (bell / SSE / inbox list). It is not
 * a plugin channel: it represents "does this notification appear in the user's
 * in-app inbox at all". Every catalogued type is addressable on it.
 */
export const INAPP_CHANNEL_ID = 'inapp';

/**
 * One notification type that can appear in the preference catalog. Declared by
 * the kernel (built-in) or by a plugin on the `notification.type` extension
 * point. Only **declared** types get a configuration entry; an undeclared type
 * is always delivered and cannot be turned off — the "no config entry means it
 * cannot be disabled" rule (this is what keeps one-time verification codes,
 * which anyway never route through the notification service, out of harm's way).
 */
export interface NotificationTypeDefinition {
  /** The exact `type` string written to `notifications`, e.g. `order.paid`. */
  type: string;
  /** Grouping key for the UI, e.g. `store` / `security`. */
  category: string;
  /** Human label (backend Chinese, per project convention). */
  label: string;
  description?: string;
  /**
   * Settings audience. Defaults to `user` (account preferences).
   * `admin` types appear only in the administrator's global policy catalog;
   * account preferences cannot read, override, or reset their delivery settings.
   * Recipient authorization remains the responsibility of the notification producer.
   */
  audience?: 'user' | 'admin';
  /** Channels enabled by default; omitted means "all available channels". */
  defaultChannels?: string[];
  /**
   * Whether a user may change this type. Defaults to `true`. `false` renders it
   * read-only (always delivered on its default channels).
   */
  userConfigurable?: boolean;
  /** Sort hint within a category. */
  order?: number;
}

/** A delivery channel addressable from the preference UI. */
export interface NotificationChannelInfo {
  /** `inapp`, or a registered `notification.channel` plugin id (e.g. `smtp`). */
  id: string;
  name: string;
  /** True for the built-in in-app inbox channel. */
  inApp: boolean;
}

/** A category grouping for the preference UI. */
export interface NotificationCategoryInfo {
  id: string;
  label: string;
}

/** Per-channel effective state for one notification type (for the current user). */
export interface NotificationChannelPreference {
  channelId: string;
  /** Effective state after admin policy × user override. */
  enabled: boolean;
  /** The base default (admin/catalog) before the user override — the toggle's reset value. */
  defaultEnabled: boolean;
  /** Whether the user may change this channel (false when non-configurable/admin-locked). */
  configurable: boolean;
}

/** One catalog type with the current user's resolved per-channel state. */
export interface NotificationTypePreference {
  type: string;
  category: string;
  label: string;
  description: string | null;
  /** Whether any channel of this type may be changed by the user. */
  configurable: boolean;
  channels: NotificationChannelPreference[];
}

/** Full preference view for the current user. */
export interface NotificationPreferencesView {
  channels: NotificationChannelInfo[];
  categories: NotificationCategoryInfo[];
  types: NotificationTypePreference[];
}

/** One user override to write: enable/disable a type on a channel. */
export interface NotificationPreferenceItem {
  type: string;
  channelId: string;
  enabled: boolean;
}

/** Admin-level policy for one notification type. */
export interface NotificationTypePolicy {
  type: string;
  category: string;
  label: string;
  /** Global admin switch: `false` disables the type on every channel. */
  enabled: boolean;
  /** Channels delivered by default (before any user override). */
  defaultChannels: string[];
  /** When true, users cannot override this type at all. */
  locked: boolean;
  /** Catalog-declared configurability (`false` is also non-overridable). */
  userConfigurable: boolean;
}

/** Full admin policy view. */
export interface NotificationPolicyView {
  channels: NotificationChannelInfo[];
  categories: NotificationCategoryInfo[];
  types: NotificationTypePolicy[];
}

/**
 * Kernel-owned two-level notification preference engine.
 *
 * Resolution order for `(user, type, channel)`:
 *   1. **Undeclared type** → always enabled (no catalog entry = cannot be
 *      disabled). This is the invariant that keeps one-off transactional
 *      messages (verification codes go through `identity`, not this service, but
 *      the rule also covers any type a plugin forgets to declare) undisableable.
 *   2. **Admin policy** (`enabled`, `defaultChannels`, `locked`) — the global
 *      floor/ceiling. `enabled: false` disables the type on every channel.
 *   3. **Catalog defaults** from {@link NotificationTypeDefinition}.
 *   4. **User overrides** — only applied to channels that stay `configurable`
 *      (not admin-locked and `userConfigurable !== false`).
 *
 * The kernel applies this before dispatch (external channels) and when listing
 * the in-app inbox/stream, so a user can, e.g., silence the inbox copy while
 * still receiving email.
 */
export interface NotificationPolicyService {
  /** Catalog + this user's resolved per-channel state, for the account UI. */
  listForUser(userId: string): Promise<NotificationPreferencesView>;
  /** Upsert this user's per-channel overrides (ignores locked/non-configurable). */
  updateForUser(userId: string, items: NotificationPreferenceItem[]): Promise<void>;
  /** Clear this user's overrides (all types, or the given subset) back to defaults. */
  resetForUser(userId: string, types?: string[]): Promise<void>;
  /** Admin policy view: catalog + global switches/defaults/locks. */
  listPolicy(): Promise<NotificationPolicyView>;
  /** Apply an admin policy patch; returns the updated view. */
  updatePolicy(patch: NotificationPolicyPatch): Promise<NotificationPolicyView>;
  /**
   * Effective verdict used by the dispatcher: is `(user, type)` enabled on
   * `channelId`? Undeclared types always return `true`.
   */
  isEnabled(userId: string, type: string, channelId: string): Promise<boolean>;
  /**
   * Effective enabled channel ids for `(user, type)`, or `null` when the type is
   * undeclared (meaning "no filtering — deliver everywhere").
   */
  enabledChannels(userId: string, type: string): Promise<Set<string> | null>;
  /**
   * Concrete `type` values (and `.*` prefixes) the user has disabled for the
   * **in-app** inbox, so the read APIs and SSE stream can drop them. `null` when
   * nothing is disabled. Prefix entries are matched with a trailing dot stripped
   * (e.g. `agent.`), mirroring the catalog's `agent.*`.
   */
  inAppExclusions(userId: string): Promise<{ exact: string[]; prefixes: string[] } | null>;
}

/** Partial admin policy update; unset fields are left unchanged. */
export interface NotificationPolicyPatch {
  types?: Record<string, { enabled?: boolean; defaultChannels?: string[]; locked?: boolean }>;
}
