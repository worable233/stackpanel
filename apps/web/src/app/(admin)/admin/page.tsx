import { SectionTitle } from '@stackpanel/ui';
import { AdminWidget } from '@/components/admin-widget';
import { BackendDashboard } from '@/components/backend-dashboard';
import { getAuthedApiClient } from '@/lib/api';
import { loadAdminOverview } from '@/lib/admin-overview';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

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
  const t = createTranslator(await getLocale());

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
    <main className="flex w-full flex-col gap-6">
      {overview ? <BackendDashboard data={overview} /> : null}

      {/* Widget 网格 */}
      {widgets.length ? (
        <div>
          <SectionTitle className="mb-4">{t('adminShell.quickLinks')}</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {widgets.map((widget) => (
              <section key={`${widget.pluginId}:${widget.id}`} className="min-w-0">
                <AdminWidget pluginId={widget.pluginId} widgetId={widget.id} />
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </main>
  );
}
