import Link from 'next/link';
import { PageHeader } from '@stackpanel/ui';
import { AdminWidget } from '@/components/admin-widget';
import { AdminOverview } from '@/components/admin-overview';
import { getAuthedApiClient } from '@/lib/api';
import { loadAdminOverview, loadRecentTickets } from '@/lib/admin-overview';
import { getLocale } from '@/i18n/locale';
import { formatDate, translate } from '@/i18n/core';

export const dynamic = 'force-dynamic';

const TICKET_STATUS_META: Record<string, { key: string; cls: string }> = {
  OPEN: { key: 'admin.ticketStatus.OPEN', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  IN_PROGRESS: {
    key: 'admin.ticketStatus.IN_PROGRESS',
    cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  },
  RESOLVED: {
    key: 'admin.ticketStatus.RESOLVED',
    cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  CLOSED: { key: 'admin.ticketStatus.CLOSED', cls: 'bg-muted text-muted-foreground' },
};

function ticketStatusMeta(status: string, t: (key: string) => string) {
  const meta = TICKET_STATUS_META[status];
  return meta
    ? { label: t(meta.key), cls: meta.cls }
    : { label: status, cls: 'bg-muted text-muted-foreground' };
}

function parseDate(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const locale = await getLocale();
  const t = (key: string) => translate(locale, key);
  const from = parseDate(sp.from);
  const to = parseDate(sp.to);

  let widgets: Array<{ id: string; title: string; description?: string; pluginId: string }> = [];
  let overview: Awaited<ReturnType<typeof loadAdminOverview>> | null = null;
  let recentTickets: Awaited<ReturnType<typeof loadRecentTickets>> = [];

  try {
    const api = await getAuthedApiClient();
    const result = await api.getAdminDashboardWidgets();
    widgets = result.widgets;
  } catch {
    widgets = [];
  }

  try {
    overview = await loadAdminOverview({ from, to });
  } catch (error) {
    console.error('[admin-overview] load failed:', error);
    overview = null;
  }

  const ticketActive = widgets.some((widget) => widget.pluginId === 'ticket');
  if (ticketActive) {
    recentTickets = await loadRecentTickets();
  }
  const otherWidgets = widgets.filter((widget) => widget.pluginId !== 'ticket');

  return (
    <main className="w-full space-y-6">
      <PageHeader title={t('nav.dashboard')} />
      <div className="space-y-6">
        {overview ? <AdminOverview data={overview} /> : null}
        {ticketActive ? (
          <section className="rounded-2xl border bg-card p-5 text-card-foreground shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{t('admin.recentTickets')}</h2>
              <Link
                href="/admin/plugin/ticket/tickets"
                className="text-xs text-primary hover:underline"
              >
                {t('notification.viewAll')}
              </Link>
            </div>
            {recentTickets.length > 0 ? (
              <ul className="mt-4 divide-y">
                {recentTickets.map((ticket) => {
                  const meta = ticketStatusMeta(ticket.status, t);
                  return (
                    <li key={ticket.id}>
                      <Link
                        href={`/admin/plugin/ticket/tickets/${ticket.id}`}
                        className="flex items-center gap-3 py-2.5 text-sm transition-colors hover:text-primary"
                      >
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {ticket.subject}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {ticket.userEmail ?? t('admin.customerFallback')}
                        </span>
                        <span
                          className={`inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}
                        >
                          <span className="size-1.5 rounded-full bg-current" />
                          {meta.label}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatDate(new Date(ticket.createdAt), locale, {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">{t('admin.noTickets')}</p>
            )}
          </section>
        ) : null}
        {otherWidgets.length ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {otherWidgets.map((widget) => (
              <div key={`${widget.pluginId}:${widget.id}`} className="space-y-1">
                <AdminWidget pluginId={widget.pluginId} widgetId={widget.id} />
                {widget.description ? (
                  <p className="px-1 text-xs text-muted-foreground">{widget.description}</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </main>
  );
}
