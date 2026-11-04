import { Suspense } from 'react';
import Link from 'next/link';
import { Settings2 } from 'lucide-react';
import { PageHeader, SectionTitle } from '@stackpanel/ui';
import { AdminWidget } from '@/components/admin-widget';
import { BackendDashboard } from '@/components/backend-dashboard';
import { Button } from '@/components/ui/button';
import { DataSkeleton } from '@/components/data-skeletons';
import { getAuthedApiClient } from '@/lib/api';
import { loadAdminOverview } from '@/lib/admin-overview';
import { getLocale } from '@/i18n/locale';
import { createTranslator, type Translator } from '@/i18n/core';

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

  return (
    <main className="flex w-full flex-col gap-6">
      <PageHeader
        title={t('nav.dashboard')}
        actions={
          <Button variant="outline" render={<Link href="/admin/settings" />}>
            <Settings2 data-icon="inline-start" />
            {t('admin.overview.settings')}
          </Button>
        }
      />

      <Suspense fallback={<DataSkeleton variant="dashboard" />}>
        <DashboardData from={from} to={to} />
      </Suspense>

      <Suspense
        fallback={
          <div>
            <SectionTitle className="mb-4">{t('adminShell.quickLinks')}</SectionTitle>
            <DataSkeleton variant="cards" rows={3} />
          </div>
        }
      >
        <DashboardWidgets t={t} />
      </Suspense>
    </main>
  );
}

async function DashboardData({ from, to }: { from: string | null; to: string | null }) {
  let overview: Awaited<ReturnType<typeof loadAdminOverview>> | null = null;
  try {
    overview = await loadAdminOverview({ from, to });
  } catch (error) {
    console.error('[admin-overview] load failed:', error);
    overview = null;
  }

  return overview ? <BackendDashboard data={overview} /> : null;
}

async function DashboardWidgets({ t }: { t: Translator }) {
  let widgets: Array<{ id: string; title: string; description?: string; pluginId: string }> = [];
  try {
    const api = await getAuthedApiClient();
    widgets = (await api.getAdminDashboardWidgets()).widgets;
  } catch {
    widgets = [];
  }

  if (!widgets.length) return null;

  return (
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
  );
}
