'use client';

import Link from 'next/link';
import { Users, Wallet, Receipt, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { useTranslator, useLocale } from '@/i18n/provider';
import { formatYuan, type AdminOverviewData } from '@/lib/admin-overview-types';
import { formatMoney } from '@/i18n';
import { OrdersTable, ProductsTable } from '@/components/admin-finance/sections';
import { PageHeader, Spotlight } from '@stackpanel/ui';

/** Dashboard composition adapted from satnaing/shadcn-admin (MIT). */
export function BackendDashboard({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  const locale = useLocale();
  const metrics = [
    {
      title: t('admin.overview.totalRevenue'),
      value: formatYuan(data.totals.revenue, locale),
      icon: Wallet,
      hint: t('admin.overview.metricHintRevenue'),
      href: '/admin/plugin/store/overview',
    },
    {
      title: t('admin.overview.orderCount'),
      value: data.totals.orderCount,
      icon: Receipt,
      hint: t('admin.overview.metricHintOrders', {
        amount: formatYuan(data.totals.monthOrderAmount, locale),
      }),
      href: '/admin/plugin/store/overview',
    },
    {
      title: t('admin.overview.userCount'),
      value: data.totals.userCount,
      icon: Users,
      hint: t('admin.overview.metricHintUsers'),
      href: '/admin/users',
    },
    {
      title: t('admin.overview.walletBalance'),
      value: formatYuan(data.totals.walletBalance, locale),
      icon: Wallet,
      hint: t('admin.overview.metricHintWalletAccounts', { count: data.totals.walletAccountCount }),
      href: '/admin/users',
    },
  ];
  return (
    <div className="backend-dashboard flex flex-col gap-7">
      <PageHeader
        title={t('nav.dashboard')}
        actions={
          <Button variant="outline" render={<Link href="/admin/settings" />}>
            <Settings2 data-icon="inline-start" />
            {t('admin.overview.settings')}
          </Button>
        }
      />
      <Tabs defaultValue="overview" className="gap-6">
        <TabsList variant="line">
          <TabsTrigger value="overview">{t('admin.overview.tabOverview')}</TabsTrigger>
          <TabsTrigger value="orders">{t('admin.overview.tabOrders')}</TabsTrigger>
          <TabsTrigger value="products">{t('admin.overview.tabProducts')}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {metrics.map(({ title, value, icon: Icon, hint, href }) => (
              <Link
                key={title}
                href={href}
                className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                aria-label={`${title}：${value}`}
              >
                <Spotlight>
                  <Card className="backend-dashboard__metric h-full gap-5 transition-colors hover:border-primary/40">
                    <CardHeader className="flex flex-row items-center justify-between gap-2">
                      <CardTitle className="text-sm font-medium">{title}</CardTitle>
                      <span className="flex size-8 items-center justify-center rounded-lg border border-primary/15 bg-primary/5 text-primary">
                        <Icon className="size-4" />
                      </span>
                    </CardHeader>
                    <CardContent>
                      <p className="text-3xl font-medium tracking-tight tabular-nums">{value}</p>
                      <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
                    </CardContent>
                  </Card>
                </Spotlight>
              </Link>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-5">
            <div className="min-w-0 lg:col-span-3">
              <Card className="h-full">
                <CardHeader className="flex flex-row items-start justify-between gap-4">
                  <CardTitle>{t('admin.overview.spendingOverview')}</CardTitle>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-primary" />
                    {t('admin.overview.totalRevenue')}
                  </span>
                </CardHeader>
                <CardContent className="relative pl-2">
                  <ChartContainer
                    config={{
                      revenue: { label: t('admin.overview.totalRevenue'), color: 'var(--primary)' },
                    }}
                    className="h-[290px] w-full sm:h-[310px]"
                  >
                    <BarChart
                      data={data.revenueSeries.map((d) => ({
                        month: d.month.slice(5),
                        revenue: d.paid,
                      }))}
                    >
                      <CartesianGrid vertical={false} strokeDasharray="3 5" />
                      <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        fontSize={12}
                        tickFormatter={(value) =>
                          formatMoney(value, 'CNY', locale, {
                            notation: 'compact',
                            maximumFractionDigits: 1,
                          })
                        }
                      />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar
                        dataKey="revenue"
                        fill="var(--primary)"
                        radius={[4, 4, 0, 0]}
                        maxBarSize={28}
                      />
                    </BarChart>
                  </ChartContainer>
                  {data.revenueSeries.every((point) => point.paid === 0) ? (
                    <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                      <span className="rounded-full bg-card/90 px-4 py-2">
                        {t('admin.overview.noData')}
                      </span>
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            </div>
            <Card className="min-w-0 lg:col-span-2">
              <CardHeader>
                <CardTitle>{t('admin.overview.recentUsers')}</CardTitle>
                <CardDescription>
                  {t('admin.overview.usersTotal', { count: data.totals.userCount })}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col divide-y divide-border/60">
                {data.recentUsers.length ? (
                  data.recentUsers.slice(0, 5).map((user) => (
                    <Link
                      href={`/admin/users/${user.id}`}
                      key={user.id}
                      className="flex items-center gap-3 rounded-md py-3 outline-none first:pt-0 last:pb-0 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Avatar className="size-9">
                        <AvatarFallback>{user.email.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium leading-none">
                          {user.email.split('@')[0]}
                        </p>
                        <p className="mt-1 truncate text-sm text-muted-foreground">{user.email}</p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {user.createdAt.slice(5, 10)}
                      </span>
                    </Link>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">{t('admin.overview.noData')}</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="orders">
          <OrdersTable data={data} />
        </TabsContent>
        <TabsContent value="products">
          <ProductsTable data={data} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
