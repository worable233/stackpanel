'use client';

import { useEffect, useRef } from 'react';
import type { NotificationView } from '@stackpanel/sdk';

export const NOTIFICATION_READ_EVENT = 'stackpanel:notification-read';

/** Acknowledge only rows actually seen, without changing the rendered read snapshot. */
export function useVisibleNotificationRead(items: NotificationView[], enabled = true) {
  const container = useRef<HTMLDivElement>(null);
  const acknowledged = useRef(new Set<string>());
  const pending = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled || !container.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            !entry.isIntersecting ||
            entry.intersectionRatio < 0.5 ||
            document.visibilityState !== 'visible'
          )
            continue;
          const id = entry.target.getAttribute('data-notification-id');
          const item = items.find((item) => item.id === id);
          if (!item || item.readAt) continue;
          const version = `${item.id}:${item.updatedAt}`;
          if (acknowledged.current.has(version) || pending.current.has(version)) continue;
          pending.current.add(version);
          void fetch(`/api/notifications/${encodeURIComponent(item.id)}/read`, { method: 'POST' })
            .then((response) => {
              if (!response.ok) return;
              acknowledged.current.add(version);
              window.dispatchEvent(new Event(NOTIFICATION_READ_EVENT));
            })
            .catch(() => {
              /* Retry on the next view; keep unread styling on failure. */
            })
            .finally(() => pending.current.delete(version));
        }
      },
      { threshold: 0.5 },
    );
    const observe = () => {
      observer.disconnect();
      container.current
        ?.querySelectorAll('[data-notification-id]')
        .forEach((row) => observer.observe(row));
    };
    observe();
    document.addEventListener('visibilitychange', observe);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', observe);
    };
  }, [items, enabled]);

  return container;
}
