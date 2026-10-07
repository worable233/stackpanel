import { AdminWidget } from '@/components/admin-widget';
import { AdminOverview } from '@/components/admin-overview';
import { getAuthedApiClient } from '@/lib/api';
import { loadAdminOverview } from '@/lib/admin-overview';

export const dynamic = 'force-dynamic';

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
  const from = parseDate(sp.from);
  const to = parseDate(sp.to);

  let widgets: Array<{ id: string; title: string; description?: string; pluginId: string }> = [];
  let overview: Awaited<ReturnType<typeof loadAdminOverview>> | null = null;

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

  return (
    <main className="w-full space-y-6">
      {overview ? <AdminOverview data={overview} /> : null}

      {widgets.length ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {widgets.map((widget) => (
            <div key={`${widget.pluginId}:${widget.id}`} className="space-y-1">
              <AdminWidget pluginId={widget.pluginId} widgetId={widget.id} />
              {widget.description ? (
                <p className="px-1 text-xs text-muted-foreground">{widget.description}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </main>
  );
}
