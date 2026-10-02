'use client';

import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { NotificationListResponse } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTranslator, useLocale } from '@/i18n/provider';
import { formatDate } from '@/i18n/core';
import { cn } from '@/lib/utils';

const POLL_INTERVAL_MS = 30_000;

export interface NotificationBellProps {
  /** Inbox page href within the current shell, e.g. `/account/notifications`. */
  inboxHref: string;
}

/**
 * Top-bar notification bell shown in both the account and admin shells.
 * Polls the unread count through the BFF proxy (30s + on window focus) and
 * shows the latest notifications in a dropdown. External channel push
 * (SSE/WebSocket/email) can replace the polling later without changing this UI.
 */
export function NotificationBell({ inboxHref }: NotificationBellProps) {
  const t = useTranslator();
  const locale = useLocale();
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<NotificationListResponse['items']>([]);

  const refreshCount = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications/unread-count', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { unreadCount: number };
      setUnreadCount(data.unreadCount);
    } catch {
      // ignore transient network errors
    }
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?limit=8', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as NotificationListResponse;
      setItems(data.items);
      setUnreadCount(data.unreadCount);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    // 挂载即拉取一次未读数，并订阅轮询/窗口聚焦。setState 发生在 await 之后，
    // 不构成同步渲染级联；规则按“调用了含 setState 的函数”保守报错。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshCount();
    const timer = setInterval(() => void refreshCount(), POLL_INTERVAL_MS);
    const onFocus = () => void refreshCount();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshCount]);

  const handleOpenChange = (open: boolean) => {
    if (open) void loadRecent();
  };

  const markAllRead = async () => {
    try {
      await fetch('/api/notifications/read-all', { method: 'POST' });
      setUnreadCount(0);
      setItems((prev) => prev.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    } catch {
      // ignore
    }
  };

  const markRead = async (id: string) => {
    try {
      await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
      setUnreadCount((prev) => Math.max(0, prev - 1));
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item,
        ),
      );
    } catch {
      // ignore
    }
  };

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("notification.ariaLabel")}
            className="relative h-9 w-9 text-foreground/80 hover:bg-accent hover:text-foreground"
          >
            <Bell className="size-4" />
            {unreadCount > 0 ? (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground ring-2 ring-background">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            ) : null}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm font-semibold text-popover-foreground">{t("notification.title")}</span>
          {unreadCount > 0 ? (
            <button
              type="button"
              onClick={() => void markAllRead()}
              className="text-xs text-primary hover:underline"
            >
              {t('notification.markAllRead')}
            </button>
          ) : null}
        </div>
        <DropdownMenuSeparator />
        <div className="max-h-96 overflow-y-auto px-1">
          {items.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t("notification.empty")}</p>
          ) : (
            items.map((item) => (
              <DropdownMenuItem key={item.id} onClick={() => void markRead(item.id)}>
                <Link
                  href={item.link ?? inboxHref}
                  className={cn(
                    'block w-full rounded-md px-2 py-2',
                    !item.readAt && 'bg-primary/5',
                  )}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={cn(
                        'mt-1.5 size-1.5 shrink-0 rounded-full',
                        item.readAt ? 'bg-transparent' : 'bg-primary',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p
                        className={cn(
                          'truncate text-sm',
                          item.readAt
                            ? 'text-muted-foreground'
                            : 'font-medium text-popover-foreground',
                        )}
                      >
                        {item.title}
                      </p>
                      {item.body ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {item.body}
                        </p>
                      ) : null}
                      <p className="mt-0.5 text-[11px] text-muted-foreground/60">
                        {formatDate(new Date(item.createdAt), locale, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </p>
                    </div>
                  </div>
                </Link>
              </DropdownMenuItem>
            ))
          )}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          render={
            <Link
              href={inboxHref}
              className="flex w-full items-center justify-center text-sm text-primary"
            />
          }
        >
          {t('notification.viewAll')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
