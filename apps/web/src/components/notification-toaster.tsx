'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { NotificationView } from '@stackpanel/sdk';
import { shouldToast, subscribeNotifications } from '@/lib/use-notification-stream';
import { useTranslator } from '@/i18n/provider';

/**
 * Bridges live notifications to sonner toasts. Mounted once per backend shell,
 * it shares the single SSE connection with the bell and inbox.
 *
 * Only **settled** notifications raise a toast (`success` / `error` / `info`);
 * an in-progress activity (`active`) is silent — its progress already shows in
 * the bell. When an activity later settles (same id, updated frame), the toast
 * fires exactly once. Ids are remembered for the session so a reconnect cannot
 * replay a toast.
 */
export function NotificationToaster() {
  const t = useTranslator();
  const router = useRouter();
  const seen = useRef(new Set<string>());

  useEffect(() => {
    return subscribeNotifications((view: NotificationView) => {
      if (!shouldToast(view, seen.current)) return;
      seen.current.add(view.id);

      const options = {
        description: view.body ?? undefined,
        action: view.link
          ? {
              label: t('notification.view'),
              onClick: () => router.push(view.link as string),
            }
          : undefined,
      };

      if (view.status === 'error') {
        toast.error(view.title, options);
      } else if (view.status === 'success') {
        toast.success(view.title, options);
      } else {
        toast(view.title, options);
      }
    });
  }, [router, t]);

  return null;
}
