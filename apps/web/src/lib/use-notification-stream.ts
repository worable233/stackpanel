'use client';

import { useEffect, useRef, useState } from 'react';
import type { NotificationView } from '@stackpanel/sdk';

/**
 * Live notification transport.
 *
 * A single `EventSource` per browser tab is shared by every consumer (bell,
 * inbox, toasts) so the app never opens a connection per component. The initial
 * list still comes from REST — the stream is additive and only carries
 * `notification.created` / `notification.updated` frames.
 *
 * `EventSource` reconnects on its own; we close it once the last subscriber
 * leaves so an idle tab holds no connection.
 */
type Listener = (view: NotificationView) => void;
type ConnectionListener = (connected: boolean) => void;

const listeners = new Set<Listener>();
const connectionListeners = new Set<ConnectionListener>();
let source: EventSource | null = null;
let connected = false;

function setConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  for (const listener of connectionListeners) listener(next);
}

function ensureSource(): void {
  if (source) return;
  try {
    source = new EventSource('/api/notifications/stream');
  } catch {
    source = null;
    return;
  }
  source.onopen = () => setConnected(true);
  source.onerror = () => setConnected(false);
  source.addEventListener('notification', (event) => {
    let view: NotificationView;
    try {
      view = JSON.parse((event as MessageEvent<string>).data) as NotificationView;
    } catch {
      // Ignore malformed frames; the next REST refresh reconciles.
      return;
    }
    for (const listener of listeners) {
      try {
        listener(view);
      } catch {
        // One bad consumer must not starve the others.
      }
    }
  });
}

function closeIfIdle(): void {
  if (listeners.size === 0 && source) {
    source.close();
    source = null;
    setConnected(false);
  }
}

/** Subscribe to live notifications; returns the unsubscribe function. */
export function subscribeNotifications(listener: Listener): () => void {
  listeners.add(listener);
  ensureSource();
  return () => {
    listeners.delete(listener);
    closeIfIdle();
  };
}

/** Observe the shared connection state (for a "live" indicator, tests, etc.). */
export function subscribeNotificationConnection(listener: ConnectionListener): () => void {
  connectionListeners.add(listener);
  listener(connected);
  return () => {
    connectionListeners.delete(listener);
  };
}

/**
 * React hook: fold live notifications into local state. Kept as the public
 * client API; the underlying transport is the shared singleton above.
 */
export function useNotificationStream(
  onNotification: (view: NotificationView) => void,
): { connected: boolean } {
  // Keep the latest callback in a ref so the subscription is opened once; the
  // listener reads `handler.current` at event time (never during render).
  const handler = useRef(onNotification);
  useEffect(() => {
    handler.current = onNotification;
  }, [onNotification]);

  const [isConnected, setIsConnected] = useState(false);
  useEffect(() => {
    const unsubscribe = subscribeNotifications((view) => handler.current(view));
    const unsubscribeConnection = subscribeNotificationConnection(setIsConnected);
    return () => {
      unsubscribe();
      unsubscribeConnection();
    };
  }, []);

  return { connected: isConnected };
}

/** Merge one streamed notification into a list, newest first, by id. */
export function mergeNotification(
  items: NotificationView[],
  view: NotificationView,
): NotificationView[] {
  const index = items.findIndex((item) => item.id === view.id);
  if (index === -1) return [view, ...items];
  const next = items.slice();
  next[index] = view;
  return next;
}

/**
 * Whether a streamed notification should raise a toast, given the ids already
 * toasted this session. Only **settled** notifications qualify: an in-progress
 * activity (`active`) advances silently in the bell and toasts once when it
 * later settles under the same id.
 */
export function shouldToast(
  view: Pick<NotificationView, 'id' | 'status' | 'readAt'>,
  seen: ReadonlySet<string>,
): boolean {
  if (seen.has(view.id)) return false;
  if (view.status === 'active') return false;
  // A notification marked read arrives already actioned; do not re-toast it.
  if (view.readAt) return false;
  return true;
}
