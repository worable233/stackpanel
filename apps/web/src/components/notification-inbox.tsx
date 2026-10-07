'use client';

import { Check, ExternalLink, CircleAlert, Loader } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { NotificationListResponse, NotificationView } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { mergeNotification, useNotificationStream } from '@/lib/use-notification-stream';
import { useLocale, useTranslator } from '@/i18n/provider';
import { formatDate } from '@/i18n/core';

type Filter = 'all' | 'unread';

const PAGE_SIZE = 50;

/** Full in-app notification inbox (account and admin share the same user-scoped list). */
export function NotificationInbox({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  const t = useTranslator();
  const locale = useLocale();
  const [filter, setFilter] = useState<Filter>('all');
  const [data, setData] = useState<NotificationListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      try {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (filter === 'unread') query.set('unreadOnly', 'true');
        if (cursor) query.set('cursor', cursor);
        const res = await fetch(`/api/notifications?${query.toString()}`, { cache: 'no-store' });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? t('notification.serviceUnavailable', { error: '' }));
        }
        const result = (await res.json()) as NotificationListResponse;
        setData((prev) =>
          cursor && prev
            ? { ...result, items: [...prev.items, ...result.items] }
            : result,
        );
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('notification.unknownError'));
      } finally {
        setLoading(false);
      }
    },
    [filter, t],
  );

  useEffect(() => {
    // filter 变化或挂载时加载首屏；setState 均在 await 之后，非同步级联。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Fold streamed live notifications into the current page's items so an
  // in-progress activity advances in place (its title/body/progress change).
  const applyLive = useCallback((view: NotificationView) => {
    setData((prev) => {
      if (!prev) return prev;
      if (filter === 'unread' && view.readAt) {
        return { ...prev, items: prev.items.filter((item) => item.id !== view.id) };
      }
      return { ...prev, items: mergeNotification(prev.items, view) };
    });
  }, [filter]);
  useNotificationStream(applyLive);

  const markRead = async (id: string) => {
    try {
      await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((item) =>
                item.id === id ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item,
              ),
              unreadCount: Math.max(0, prev.unreadCount - 1),
            }
          : prev,
      );
    } catch {
      // ignore
    }
  };

  const markAllRead = async () => {
    try {
      await fetch('/api/notifications/read-all', { method: 'POST' });
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((item) =>
                item.readAt ? item : { ...item, readAt: new Date().toISOString() },
              ),
              unreadCount: 0,
            }
          : prev,
      );
    } catch {
      // ignore
    }
  };

  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
              {(['all', 'unread'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    filter === value
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {value === 'all' ? t('notification.all') : t('notification.unread')}
                  {value === 'unread' && (data?.unreadCount ?? 0) > 0
                    ? ` (${data?.unreadCount ?? 0})`
                    : ''}
                </button>
              ))}
            </div>
            {(data?.unreadCount ?? 0) > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void markAllRead()}
                className="w-fit"
              >
                <Check className="size-4" />
                {t('notification.markAllRead')}
              </Button>
            ) : null}
          </>
        }
      />

      {error ? (
        <p className="text-sm text-destructive">
          {t('notification.serviceUnavailable', { error })}
        </p>
      ) : null}

      {items.length === 0 && !loading ? (
        <div className="rounded-lg border py-16 text-center text-sm text-muted-foreground">
          {filter === 'unread' ? t('notification.emptyUnread') : t('notification.emptyAll')}
        </div>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 p-4">
              <InboxGlyph item={item} />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'text-sm',
                    item.readAt ? 'text-foreground/70' : 'font-medium text-foreground',
                  )}
                >
                  {item.title}
                </p>
                {item.body ? (
                  <p className="mt-1 text-sm text-muted-foreground">{item.body}</p>
                ) : null}
                {item.status === 'active' && item.progress !== null ? (
                  <div className="mt-2 flex items-center gap-3">
                    <Progress className="h-1.5 max-w-xs" value={item.progress} />
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {item.progress}%
                    </span>
                  </div>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground/70">
                  {formatDate(new Date(item.createdAt), locale, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}{' '}
                  · {item.type}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {!item.readAt ? (
                  <Button variant="ghost" size="sm" onClick={() => void markRead(item.id)}>
                    <Check className="size-4" />
                    {t('notification.markRead')}
                  </Button>
                ) : null}
                {item.link ? (
                  <Button
                    render={
                      <Link
                        href={item.link}
                        className="flex items-center gap-1 text-xs text-primary"
                      />
                    }
                    variant="ghost"
                    size="sm"
                  >
                    <ExternalLink className="size-3.5" />
                    {t('notification.view')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
          {loading ? (
            <li className="p-4 text-center text-sm text-muted-foreground">
              {t('notification.loading')}
            </li>
          ) : null}
        </ul>
      )}

      {data?.nextCursor ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void load(data.nextCursor!)} className="w-fit">
            {t('notification.loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Status glyph for an inbox row; a plain dot for one-shot notifications. */
function InboxGlyph({ item }: { item: NotificationView }) {
  if (item.status === 'active') {
    return <Loader className="mt-1 size-4 shrink-0 animate-spin text-primary" />;
  }
  if (item.status === 'success') {
    return <Check className="mt-1 size-4 shrink-0 text-emerald-500" />;
  }
  if (item.status === 'error') {
    return <CircleAlert className="mt-1 size-4 shrink-0 text-destructive" />;
  }
  return (
    <span
      className={cn(
        'mt-1.5 size-2 shrink-0 rounded-full',
        item.readAt ? 'bg-transparent ring-1 ring-border' : 'bg-primary',
      )}
    />
  );
}
