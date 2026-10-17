import { AdminWidget } from '@/components/admin-widget';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { MetricCard } from '@/components/clarity';
import { getAuthedApiClient } from '@/lib/api';
import { loadAdminOverview } from '@/lib/admin-overview';
import { Users, ShoppingCart, DollarSign, Activity } from 'lucide-react';

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
    <main className="w-full space-y-8">
      {/* 数据概览 */}
      {overview ? (
        <div>
          <h2 className="mb-4 text-2xl font-semibold">数据概览</h2>
          <div className="grid gap-6 md:grid-cols-4">
            <MetricCard
              icon={Users}
              value={overview.totals.userCount.toString()}
              label="总用户数"
            />
            <MetricCard
              icon={ShoppingCart}
              value={overview.totals.monthOrderCount.toString()}
              label="活跃订单"
              trend="+12%"
            />
            <MetricCard
              icon={DollarSign}
              value={`¥${(overview.totals.revenue / 100).toFixed(2)}`}
              label="本月收入"
              trend="+23%"
            />
            <MetricCard icon={Activity} value="99.9%" label="系统可用率" />
          </div>
        </div>
      ) : null}

      {/* Widget 网格 */}
      {widgets.length ? (
        <div>
          <h2 className="mb-4 text-2xl font-semibold">仪表板</h2>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {widgets.map((widget) => (
              <Card
                key={`${widget.pluginId}:${widget.id}`}
                interactive
                className="overflow-hidden"
              >
                <CardHeader>
                  <CardTitle className="text-base">{widget.title}</CardTitle>
                  {widget.description ? (
                    <CardDescription className="text-xs">{widget.description}</CardDescription>
                  ) : null}
                </CardHeader>
                <CardContent className="pt-0">
                  <AdminWidget pluginId={widget.pluginId} widgetId={widget.id} />
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ) : null}
    </main>
  );
}
