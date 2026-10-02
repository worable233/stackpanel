'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { formatYuan, type AdminOverviewData } from '@/lib/admin-overview-types';
import { useLocale, useTranslator } from '@/i18n/provider';
import { formatNumber, formatDate, type Translator } from '@/i18n/core';
import type { Locale } from '@/i18n/config';

import { BadgeCheck, CircleDollarSign, Package, ShoppingCart, Users } from 'lucide-react';

const STATUS_STYLES: Record<string, string> = {
  PAID: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  PENDING: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  CANCELLED: 'bg-red-500/15 text-red-600 dark:text-red-400',
  EXPIRED: 'bg-muted text-muted-foreground',
  REFUNDED: 'bg-muted text-muted-foreground',
};

const ORDER_STATUS_KEYS: Record<string, string> = {
  PENDING: 'orderStatus.PENDING',
  PAID: 'orderStatus.PAID',
  CANCELLED: 'orderStatus.CANCELLED',
  EXPIRED: 'orderStatus.EXPIRED',
  REFUNDED: 'orderStatus.REFUNDED',
};

function orderStatusLabel(status: string, t: Translator): string {
  const key = ORDER_STATUS_KEYS[status];
  return key ? t(key) : status;
}

function kpiCards(data: AdminOverviewData, t: Translator, locale: Locale) {
  const fmtPct = (v: number | null) =>
    v === null ? null : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  return [
    {
      label: t('admin.overview.totalRevenue'),
      value: formatYuan(data.totals.revenue, locale),
      hint: t('admin.overview.totalRevenueHint'),
      delta: fmtPct(data.deltas.revenuePct),
      icon: CircleDollarSign,
    },
    {
      label: t('admin.overview.orderCount'),
      value: formatNumber(data.totals.orderCount, locale),
      hint: t('admin.overview.orderCountHint', { count: data.totals.pendingCount }),
      delta: fmtPct(data.deltas.orderPct),
      icon: ShoppingCart,
    },
    {
      label: t('admin.overview.userCount'),
      value: formatNumber(data.totals.userCount, locale),
      hint: t('admin.overview.userCountHint'),
      delta: fmtPct(data.deltas.userPct),
      icon: Users,
    },
    {
      label: t('admin.overview.walletBalance'),
      value: formatYuan(data.totals.walletBalance, locale),
      hint: t('admin.overview.walletBalanceHint', { count: data.totals.walletAccountCount }),
      delta: null,
      icon: Package,
    },
  ];
}

function KpiCard({
  label,
  value,
  hint,
  delta,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint: string;
  delta: string | null;
  icon: React.ComponentType<{ className?: string }>;
}) {
  const up = delta ? delta.startsWith('+') : false;
  return (
    <div className="w-full lg:w-3/12 md:w-6/12 border-0 border-b last:border-b-0 md:border-e md:even:border-e-0 md:nth-[n+3]:border-b-0 lg:border-b-0 lg:even:border-e lg:last:border-e-0">
      <div className="p-6 flex items-start justify-between">
        <div className="flex flex-col gap-4">
          <p className="text-base font-medium text-card-foreground">{label}</p>
          <div className="flex flex-col gap-1.5">
            <p className="text-2xl font-medium tracking-tight text-card-foreground">{value}</p>
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">{hint}</p>
              {delta ? (
                <span
                  className={`inline-flex h-5 w-fit shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-normal transition-all ${
                    up
                      ? 'bg-teal-400/10 text-teal-400'
                      : 'bg-red-600/10 text-red-600 dark:bg-red-500/10 dark:text-red-400'
                  }`}
                >
                  {delta}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="rounded-full p-3 outline outline-1 -outline-offset-1 outline-foreground/10">
          <Icon className="size-4 text-foreground" />
        </div>
      </div>
    </div>
  );
}

const overviewConfig = (t: Translator) =>
  ({
    paid: {
      label: t('admin.overview.paid'),
      color: 'var(--color-chart-1)',
    },
    pipeline: {
      label: t('admin.overview.allOrders'),
      color: 'var(--color-chart-3)',
    },
  }) satisfies ChartConfig;

const statusConfig = (t: Translator) =>
  ({
    value: { label: t('admin.overview.orderCount') },
  }) satisfies ChartConfig;

/** Month keys are `YYYY-MM`; render a locale-aware short label. */
function monthLabel(key: string, locale: Locale): string {
  const [y, m] = key.split('-').map(Number);
  if (y === undefined || m === undefined) return key;
  return formatDate(new Date(y, m - 1, 1), locale, { year: 'numeric', month: 'short' });
}

function dayLabel(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${m}/${d}`;
}

const STATUS_COLORS = ['var(--color-chart-1)', 'var(--color-chart-4)', 'var(--color-chart-5)'];

export function AdminOverview({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  const locale = useLocale();
  const cards = kpiCards(data, t, locale);
  const momChange = data.deltas.revenuePct;

  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-12">
        <Card className="gap-0 overflow-hidden rounded-xl shadow-xs">
          <div className="flex w-full flex-wrap px-0 lg:flex-nowrap">
            {cards.map((card) => (
              <KpiCard key={card.label} {...card} />
            ))}
          </div>
        </Card>
      </div>

      <div className="col-span-12 xl:col-span-8">
        <Card className="gap-0 overflow-hidden rounded-xl shadow-xs">
          <CardHeader className="rounded-t-xl">
            <CardTitle className="text-base">{t('admin.overview.revenueOverview')}</CardTitle>
            <div className="flex items-end justify-between gap-3">
              <div className="flex flex-col gap-1">
                <p className="text-3xl font-semibold tracking-tight">
                  {formatYuan(data.totals.revenue, locale)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {momChange !== null
                    ? t('admin.overview.vsLastMonth', {
                        pct: `${momChange >= 0 ? '+' : ''}${momChange.toFixed(1)}`,
                      })
                    : t('admin.overview.revenueAllTime')}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-chart-1" />
                  <p className="text-sm text-muted-foreground">{t('admin.overview.paid')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-chart-3" />
                  <p className="text-sm text-muted-foreground">{t('admin.overview.allOrders')}</p>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ChartContainer config={overviewConfig(t)} className="h-[260px] w-full">
              <ResponsiveContainer>
                <AreaChart data={data.revenueSeries} margin={{ left: 0, right: 0 }}>
                  <defs>
                    <linearGradient id="fillPaid" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="fillPipeline" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--color-chart-3)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--color-chart-3)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="month"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={(key: string) => monthLabel(key, locale)}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    width={50}
                    tickFormatter={(v: number) =>
                      formatNumber(v / 100, locale, { maximumFractionDigits: 0 })
                    }
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(l) => String(l)}
                        formatter={(value) => formatYuan(Number(value), locale)}
                      />
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="pipeline"
                    stroke="var(--color-chart-3)"
                    fill="url(#fillPipeline)"
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="paid"
                    stroke="var(--color-chart-1)"
                    fill="url(#fillPaid)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <div className="col-span-12 md:col-span-6 xl:col-span-4">
        <Card className="gap-0 overflow-hidden rounded-xl shadow-xs">
          <CardHeader className="rounded-t-xl">
            <CardTitle className="text-base">{t('admin.overview.orderStatus')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={statusConfig(t)} className="h-[220px] w-full">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={data.statusBreakdown.map((item) => ({
                      name: orderStatusLabel(item.status, t),
                      value: item.value,
                    }))}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={2}
                  >
                    {data.statusBreakdown.map((_, index) => (
                      <Cell key={index} fill={STATUS_COLORS[index % STATUS_COLORS.length]} />
                    ))}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                </PieChart>
              </ResponsiveContainer>
            </ChartContainer>
            <div className="mt-2 flex flex-col gap-2">
              {data.statusBreakdown.map((item, index) => (
                <div key={item.status} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-[2px]"
                      style={{
                        backgroundColor: `var(--color-chart-${index + 1})`,
                      }}
                    />
                    <span className="text-muted-foreground">{orderStatusLabel(item.status, t)}</span>
                  </div>
                  <span className="font-medium tabular-nums">{item.value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="col-span-12">
        <form method="get" action="/admin" className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 rounded-xl border bg-card px-3 py-2 shadow-xs">
            <input
              type="date"
              name="from"
              defaultValue={data.range.from ?? ''}
              className="bg-transparent text-sm text-card-foreground outline-none"
            />
            <span className="text-muted-foreground">{t('admin.overview.to')}</span>
            <input
              type="date"
              name="to"
              defaultValue={data.range.to ?? ''}
              className="bg-transparent text-sm text-card-foreground outline-none"
            />
          </div>
          <button
            type="submit"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80"
          >
            {t('admin.overview.apply')}
          </button>
          {data.range.from || data.range.to ? (
            <Link
              href="/admin"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm text-foreground hover:bg-muted"
            >
              {t('admin.overview.clearFilter')}
            </Link>
          ) : null}
        </form>
      </div>

      <div className="col-span-12 md:col-span-6 xl:col-span-4">
        <Card className="gap-0 overflow-hidden rounded-xl shadow-xs">
          <CardHeader className="rounded-t-xl">
            <CardTitle className="text-base">{t('admin.overview.productRevenue')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={statusConfig(t)} className="h-[220px] w-full">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={data.sourceBreakdown}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={2}
                  >
                    {data.sourceBreakdown.map((_, index) => (
                      <Cell key={index} fill={STATUS_COLORS[index % STATUS_COLORS.length]} />
                    ))}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                </PieChart>
              </ResponsiveContainer>
            </ChartContainer>
            <div className="mt-2 flex flex-col gap-2">
              {data.sourceBreakdown.map((item, index) => (
                <div key={item.name} className="flex items-center justify-between gap-2 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-[2px]"
                      style={{
                        backgroundColor: `var(--color-chart-${index + 1})`,
                      }}
                    />
                    <span className="truncate text-muted-foreground">{item.name}</span>
                  </div>
                  <span className="shrink-0 font-medium tabular-nums">
                    {formatYuan(item.value, locale)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="col-span-12 md:col-span-6 xl:col-span-4">
        <Card className="gap-0 overflow-hidden rounded-xl shadow-xs">
          <CardHeader className="rounded-t-xl">
            <CardTitle className="text-base">{t('admin.overview.weekSales')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer config={statusConfig(t)} className="h-[220px] w-full">
              <ResponsiveContainer>
                <BarChart data={data.weekSeries} margin={{ left: 0, right: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="day"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={dayLabel}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(l) => String(l)}
                        formatter={(value) => formatYuan(Number(value), locale)}
                      />
                    }
                  />
                  <Bar dataKey="revenue" fill="var(--color-chart-2)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <div className="col-span-12 md:col-span-6 xl:col-span-4">
        <Card className="gap-0 overflow-hidden rounded-xl shadow-xs">
          <CardHeader className="rounded-t-xl">
            <CardTitle className="text-base">{t('admin.overview.topProducts')}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.topProducts.length ? (
              <div className="flex flex-col gap-3">
                {data.topProducts.map((product, index) => (
                  <div
                    key={product.name}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {index + 1}
                      </span>
                      <span className="truncate font-medium">{product.name}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-xs text-muted-foreground">
                        {t('admin.overview.salesCount', { count: product.sales })}
                      </span>
                      <span className="font-medium tabular-nums">
                        {formatYuan(product.revenue, locale)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('admin.overview.noData')}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="col-span-12 xl:col-span-8">
        <Card className="gap-0 overflow-hidden rounded-xl shadow-xs">
          <CardHeader className="rounded-t-xl">
            <CardTitle className="text-base">{t('admin.overview.recentOrders')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2.5 font-medium">{t('admin.overview.colOrderId')}</th>
                    <th className="px-2 py-2.5 font-medium">{t('admin.overview.colCustomer')}</th>
                    <th className="px-2 py-2.5 font-medium">{t('admin.overview.colProduct')}</th>
                    <th className="px-2 py-2.5 text-right font-medium">
                      {t('admin.overview.colAmount')}
                    </th>
                    <th className="px-2 py-2.5 font-medium">{t('admin.overview.colStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentOrders.map((order) => (
                    <tr key={order.id} className="border-b text-card-foreground last:border-0">
                      <td className="px-2 py-2.5 font-mono text-xs">{order.id}</td>
                      <td className="px-2 py-2.5 text-muted-foreground">
                        {order.customer || t('admin.overview.customerFallback')}
                      </td>
                      <td className="max-w-[180px] truncate px-2 py-2.5">{order.product}</td>
                      <td className="px-2 py-2.5 text-right font-medium tabular-nums">
                        {formatYuan(order.total, locale)}
                      </td>
                      <td className="px-2 py-2.5">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[order.status] ?? 'bg-muted text-muted-foreground'}`}
                        >
                          {order.status === 'PAID' ? <BadgeCheck className="size-3" /> : null}
                          {orderStatusLabel(order.status, t)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="col-span-12 xl:col-span-4">
        <Card className="gap-0 overflow-hidden rounded-xl shadow-xs">
          <CardHeader className="rounded-t-xl">
            <CardTitle className="text-base">{t('admin.overview.recentActivity')}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentEvents.length ? (
              <div className="flex flex-col gap-4">
                {data.recentEvents.map((event, index) => (
                  <div key={index} className="flex items-start gap-3 text-sm">
                    <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                      {event.time}
                    </span>
                    <span className="text-card-foreground">
                      {event.status === 'PAID'
                        ? t('admin.overview.eventPaid', { id: event.orderId })
                        : event.status === 'CANCELLED'
                          ? t('admin.overview.eventCancelled', { id: event.orderId })
                          : t('admin.overview.eventPending', { id: event.orderId })}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('admin.overview.noActivity')}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
