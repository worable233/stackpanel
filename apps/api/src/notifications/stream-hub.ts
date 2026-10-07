import type { EventBus, NotificationView } from '@stackpanel/sdk';

/**
 * Server-Sent Events fan-out for the per-user notification stream.
 *
 * The cross-replica part is already solved: the outbox event bus relays
 * `notification.created` / `notification.updated` to every replica over Redis
 * Pub/Sub (ADR-0013), so each process only needs to deliver the events it
 * receives to the SSE connections it currently holds for the matching user.
 * No new Redis channel or key prefix is introduced.
 *
 * A sink is the write side of one SSE response. The hub filters by `userId`, so
 * a connection never observes another user's notifications.
 */
export type NotificationSink = (view: NotificationView) => void;

interface NotificationEventPayload {
  notification?: NotificationView;
  userId?: string;
}

export class NotificationStreamHub {
  private readonly byUser = new Map<string, Set<NotificationSink>>();
  private dispose: (() => void) | null = null;

  constructor(private readonly events: EventBus) {}

  /** Begin observing the event bus. Idempotent. */
  start(): void {
    if (this.dispose) return;
    const onEvent = (payload: unknown): void => this.dispatch(payload);
    const offCreated = this.events.subscribe('notification.created', onEvent);
    const offUpdated = this.events.subscribe('notification.updated', onEvent);
    this.dispose = () => {
      offCreated();
      offUpdated();
    };
  }

  /** Register an SSE sink for one user; returns the disposer. */
  subscribe(userId: string, sink: NotificationSink): () => void {
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    set.add(sink);
    return () => {
      const current = this.byUser.get(userId);
      if (!current) return;
      current.delete(sink);
      if (current.size === 0) this.byUser.delete(userId);
    };
  }

  /** Number of connected sinks (metrics / tests). */
  get connectionCount(): number {
    let total = 0;
    for (const set of this.byUser.values()) total += set.size;
    return total;
  }

  private dispatch(payload: unknown): void {
    const { notification, userId } = (payload ?? {}) as NotificationEventPayload;
    if (!notification || !userId) return;
    const sinks = this.byUser.get(userId);
    if (!sinks) return;
    for (const sink of sinks) {
      try {
        sink(notification);
      } catch {
        // A broken sink is dropped by its own close handler; never throw here.
      }
    }
  }
}

/** Process-wide hub. */
let hub: NotificationStreamHub | null = null;

/**
 * Lazily create and start the singleton hub. Multiple `buildApp()` instances in
 * one process share it, matching the process-wide event bus semantics.
 */
export function getNotificationStreamHub(events: EventBus): NotificationStreamHub {
  if (!hub) {
    hub = new NotificationStreamHub(events);
    hub.start();
  }
  return hub;
}
