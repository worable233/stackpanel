'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  CartesianGrid,
  Label,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts';
import { Blocks, ChevronRight, Package, Palette, Receipt, ScrollText, Settings2, TrendingUp, UserCog, Users } from 'lucide-react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Field } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatYuan, type AdminOverviewData } from '@/lib/admin-overview-types';
import { useLocale, useTranslator } from '@/i18n/provider';
import { formatCurrency } from '@/i18n';
import { formatNumber, formatDate, type Translator } from '@/i18n/core';
import type { Locale } from '@/i18n/config';

const CHART_FILLS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
];

const CHART_DOTS = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'];

const CHART_BARS = ['bg-chart-3', 'bg-chart-3/75', 'bg-chart-3/50', 'bg-chart-3/30'];

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

function fillAt(index: number): string {
  return CHART_FILLS[index % CHART_FILLS.length] ?? 'var(--color-chart-1)';
}

function dotAt(index: number): string {
  return CHART_DOTS[index % CHART_DOTS.length] ?? 'bg-chart-1';
}

function DeltaBadge({ value }: { value: number | null }) {
  if (value === null) return null;
  const up = value >= 0;
  return (
    <Badge
      className={
        up
          ? 'bg-green-500/10 text-green-700 dark:bg-green-500/15 dark:text-green-300'
          : 'bg-destructive/10 text-destructive'
      }
    >
      {`${up ? '+' : ''}${value.toFixed(1)}%`}
    </Badge>
  );
}

/** 2×2 metric grid (revenue / orders / users / wallet). */
export function OverviewKpis({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  const locale = useLocale();
  const cards = [
    {
      title: t('admin.overview.totalRevenue'),
      value: formatYuan(data.totals.revenue, locale),
      hint: t('admin.overview.metricHintRevenue'),
      delta: data.deltas.revenuePct,
      cell: 'border-b xl:border-e',
    },
    {
      title: t('admin.overview.orderCount'),
      value: formatNumber(data.totals.orderCount, locale),
      hint: t('admin.overview.metricHintOrders', {
        amount: formatYuan(data.totals.monthOrderAmount, locale),
      }),
      delta: data.deltas.orderPct,
      cell: 'border-b',
    },
    {
      title: t('admin.overview.userCount'),
      value: formatNumber(data.totals.userCount, locale),
      hint: t('admin.overview.metricHintUsers'),
      delta: data.deltas.userPct,
      cell: 'border-b xl:border-e xl:border-b-0',
    },
    {
      title: t('admin.overview.walletBalance'),
      value: formatYuan(data.totals.walletBalance, locale),
      hint: t('admin.overview.metricHintWalletAccounts', {
        count: data.totals.walletAccountCount,
      }),
      delta: null,
      cell: 'xl:border-b-0',
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="grid grid-cols-1 xl:grid-cols-8">
        {cards.map((card) => (
          <Card
            key={card.title}
            className={`gap-5 overflow-hidden rounded-none border-0 border-foreground/10 ring-0 xl:col-span-4 ${card.cell}`}
          >
            <CardHeader>
              <CardTitle className="font-normal">{card.title}</CardTitle>
            </CardHeader>
            <CardContent className="flex items-end justify-between gap-3">
              <div className="space-y-1">
                <div className="text-3xl leading-none tracking-tight">
                  {card.value}
                </div>
                <p className="text-xs text-muted-foreground">{card.hint}</p>
              </div>
              <DeltaBadge value={card.delta} />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** Top revenue-generating products as dashed-separated share columns. */
export function RevenueSources({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  const locale = useLocale();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-normal">{t('admin.overview.incomeSources')}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-1 md:grid-cols-3">
        {data.topProducts.length ? (
          data.topProducts.slice(0, 3).map((product, index) => (
            <section key={product.name} className="isolate flex gap-[0.5px]">
              <Separator
                orientation="vertical"
                className="mb-1 h-auto self-auto border-l border-dashed border-muted-foreground/50 bg-transparent"
              />
              <div className="flex min-h-24 flex-1 flex-col justify-between">
                <div className="flex min-w-0 flex-col gap-1 px-1">
                  <p className="wrap-break-word text-xs leading-none text-muted-foreground">
                    {t('admin.overview.incomeSourceHint', {
                      name: product.name,
                      pct: product.pct,
                    })}
                  </p>
                  <div className="text-lg leading-none tracking-tight">
                    {formatYuan(product.revenue, locale)}
                  </div>
                </div>
                <div
                  className={`-ml-0.5 h-5 rounded-sm ${CHART_BARS[index % CHART_BARS.length]}`}
                />
              </div>
            </section>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">{t('admin.overview.noData')}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Inline order-period summary row (replaces the reference credit-score note). */
export function OrderSummaryNote({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  return (
    <Item className="rounded-xl" variant="outline">
      <ItemMedia variant="icon">
        <TrendingUp />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{t('admin.overview.creditTitle')}</ItemTitle>
        <ItemDescription>
          {t('admin.overview.creditText', {
            count: data.totals.orderCount,
            paid: data.totals.paidOrderCount,
          })}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button size="sm" variant="outline" render={<Link href="/admin/market" />}>
          {t('admin.overview.viewDetails')}
        </Button>
      </ItemActions>
    </Item>
  );
}

const trendConfig = (t: Translator) =>
  ({
    revenue: { label: t('admin.overview.paid'), color: 'var(--color-chart-4)' },
    pipeline: { label: t('admin.overview.allOrders'), color: 'var(--color-chart-2)' },
  }) satisfies ChartConfig;

function shortDate(key: string, locale: Locale): string {
  if (/^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split('-').map(Number);
    return formatDate(new Date(y!, m! - 1, 1), locale, { month: 'short' });
  }
  const date = new Date(`${key}T00:00:00`);
  return Number.isNaN(date.getTime()) ? key : formatDate(date, locale, { weekday: 'short' });
}

/** Two-line revenue trend (paid vs. all orders) with a range selector. */
export function RevenueTrendCard({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  const locale = useLocale();
  const [range, setRange] = useState<'weekly' | 'monthly'>('weekly');

  const chartData =
    range === 'weekly'
      ? data.weekSeries.map((d) => ({ key: d.day, revenue: d.revenue, pipeline: d.pipeline }))
      : data.revenueSeries.map((d) => ({ key: d.month, revenue: d.paid, pipeline: d.pipeline }));

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="font-normal">{t('admin.overview.spendingOverview')}</CardTitle>
        <CardAction>
          <Select value={range} onValueChange={(value) => setRange(value as 'weekly' | 'monthly')}>
            <SelectTrigger className="w-28" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="weekly">{t('admin.overview.weekly')}</SelectItem>
                <SelectItem value="monthly">{t('admin.overview.monthly')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ChartContainer config={trendConfig(t)} className="h-50 w-full">
          <LineChart
            accessibilityLayer
            data={chartData}
            margin={{ bottom: 0, left: 0, right: 0, top: 0 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="key"
              tickLine={false}
              tickMargin={10}
              tick={{ fontSize: 12 }}
              tickFormatter={(key: string) => shortDate(key, locale)}
            />
            <YAxis hide axisLine={false} tickLine={false} tickMargin={10} tick={{ fontSize: 12 }} />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(l) => shortDate(String(l), locale)}
                  formatter={(value) => formatYuan(Number(value), locale)}
                />
              }
            />
            <Line
              connectNulls
              dataKey="pipeline"
              dot={false}
              stroke="var(--color-pipeline)"
              strokeDasharray="5 5"
              strokeLinecap="round"
              strokeWidth={1}
              type="linear"
            />
            <Line
              dataKey="revenue"
              dot={false}
              stroke="var(--color-revenue)"
              strokeLinecap="round"
              strokeWidth={3}
              type="linear"
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

const statusConfig = (t: Translator) =>
  ({
    amount: { label: t('admin.overview.orderStatus') },
  }) satisfies ChartConfig;

/** Order-status donut with a centred total and a count/share legend. */
export function OrderStatusCard({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  const locale = useLocale();
  const total = data.statusBreakdown.reduce((s, item) => s + item.value, 0);
  const chartData = data.statusBreakdown.map((item, index) => ({
    name: orderStatusLabel(item.status, t),
    amount: item.value,
    pct: total > 0 ? Math.round((item.value / total) * 100) : 0,
    fill: fillAt(index),
  }));

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="font-normal">{t('admin.overview.orderStatusTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="grid items-center gap-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)]">
        {chartData.length ? (
          <ChartContainer config={statusConfig(t)} className="mx-auto aspect-square h-50">
            <PieChart>
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    hideLabel
                    className="w-52"
                    nameKey="name"
                    formatter={(value) => formatNumber(Number(value), locale)}
                  />
                }
              />
              <Pie
                cornerRadius={6}
                data={chartData}
                dataKey="amount"
                innerRadius={65}
                nameKey="name"
                outerRadius={90}
                paddingAngle={2}
                strokeWidth={5}
              >
                <Label
                  content={({ viewBox }) => {
                    if (!(viewBox && 'cx' in viewBox && 'cy' in viewBox)) return null;
                    return (
                      <text
                        dominantBaseline="middle"
                        textAnchor="middle"
                        x={viewBox.cx}
                        y={viewBox.cy}
                      >
                        <tspan
                          className="fill-muted-foreground text-xs"
                          x={viewBox.cx}
                          y={(viewBox.cy ?? 0) - 8}
                        >
                          {t('admin.overview.total')}
                        </tspan>
                        <tspan
                          className="fill-foreground text-lg font-medium tabular-nums"
                          x={viewBox.cx}
                          y={(viewBox.cy ?? 0) + 14}
                        >
                          {formatNumber(total, locale)}
                        </tspan>
                      </text>
                    );
                  }}
                />
              </Pie>
            </PieChart>
          </ChartContainer>
        ) : (
          <div className="mx-auto grid aspect-square h-50 place-items-center">
            <div className="grid size-40 place-items-center rounded-full border border-dashed border-border">
              <span className="text-sm text-muted-foreground">
                {t('admin.overview.noData')}
              </span>
            </div>
          </div>
        )}

        <div className="flex min-w-0 flex-col gap-3">
          {chartData.length ? (
            chartData.map((item, index) => (
              <div className="grid grid-cols-[1fr_auto] items-end gap-3" key={item.name}>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1">
                    <span aria-hidden className={`h-2 w-1 rounded-full ${dotAt(index)}`} />
                    <p className="truncate text-xs text-muted-foreground">{item.name}</p>
                  </div>
                  <p className="font-medium tabular-nums">{formatNumber(item.amount, locale)}</p>
                </div>
                <div className="font-medium tabular-nums">{item.pct}%</div>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">{t('admin.overview.noData')}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Most recent orders list. */
export function RecentOrdersCard({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  const locale = useLocale();
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="font-normal">{t('admin.overview.recentOrders')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data.recentOrders.length ? (
          <div className="flex flex-col gap-4">
            {data.recentOrders.slice(0, 5).map((order) => (
              <div key={order.id} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm leading-none font-medium text-foreground">
                    {order.product}
                  </span>
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {order.customer || t('admin.overview.customerFallback')}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm font-medium tabular-nums">
                    {formatYuan(order.total, locale)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {orderStatusLabel(order.status, t)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('admin.overview.noData')}</p>
        )}
        <Separator />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('admin.overview.ordersTotal', { count: data.totals.orderCount })}</span>
          <Link href="/admin/market" className="font-medium text-primary hover:underline">
            {t('admin.overview.viewDetails')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

/** Newest registrations, newest first. */
export function RecentUsersCard({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  const locale = useLocale();
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="font-normal">{t('admin.overview.recentUsers')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {data.recentUsers.length ? (
          <div className="flex flex-col gap-4">
            {data.recentUsers.map((user) => (
              <div key={user.id} className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar className="size-8">
                    <AvatarFallback className="text-xs">
                      {user.email.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span className="truncate text-sm font-medium text-foreground">
                    {user.email}
                  </span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDate(new Date(user.createdAt), locale, {
                    month: '2-digit',
                    day: '2-digit',
                  })}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('admin.overview.noData')}</p>
        )}
        <Separator />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('admin.overview.usersTotal', { count: data.totals.userCount })}</span>
          <Link href="/admin/users" className="font-medium text-primary hover:underline">
            {t('admin.overview.viewDetails')}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

/** Contact search + round icon shortcuts, mirroring the reference's two-card column. */
export function QuickActions({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  const contacts = Array.from(
    new Set(data.recentOrders.map((order) => order.customer).filter(Boolean)),
  ).slice(0, 4);
  const shortcuts = [
    { label: t('admin.overview.shortcutOrders'), href: '/admin/market', icon: Receipt },
    { label: t('admin.overview.shortcutUsers'), href: '/admin/users', icon: Users },
    { label: t('admin.overview.shortcutProducts'), href: '/admin/market', icon: Package },
    { label: t('admin.overview.shortcutPlugins'), href: '/admin/plugins', icon: Blocks },
    { label: t('admin.overview.shortcutRbac'), href: '/admin/rbac', icon: UserCog },
    { label: t('admin.overview.shortcutAudit'), href: '/admin/audit', icon: ScrollText },
    { label: t('admin.overview.shortcutThemes'), href: '/admin/themes', icon: Palette },
    { label: t('admin.overview.shortcutSettings'), href: '/admin/settings', icon: Settings2 },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="font-normal">{t('admin.overview.quickSearch')}</CardTitle>
          <CardAction>
            <div className="flex items-center gap-1">
              {contacts.length ? (
                <div className="flex -space-x-2">
                  {contacts.map((email) => (
                    <Avatar key={email} className="size-7 border-2 border-background">
                      <AvatarFallback className="text-[10px]">
                        {email.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                  ))}
                </div>
              ) : null}
              <ChevronRight className="size-4" />
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          <form method="get" action="/admin/users">
            <Field orientation="horizontal">
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>
                    <Users />
                  </InputGroupText>
                </InputGroupAddon>
                <InputGroupInput name="q" placeholder={t('admin.overview.quickSearchPlaceholder')} />
              </InputGroup>
              <Button type="submit">{t('admin.overview.quickSearchAction')}</Button>
            </Field>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="font-normal">{t('admin.overview.quickActions')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4">
            {shortcuts.map((shortcut) => {
              const Icon = shortcut.icon;
              return (
                <div key={shortcut.label} className="flex flex-col items-center gap-2.5">
                  <Button
                    variant="outline"
                    className="size-12 rounded-full"
                    render={<Link href={shortcut.href} />}
                  >
                    <Icon className="size-5" />
                  </Button>
                  <span className="text-center text-xs text-muted-foreground">{shortcut.label}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Full order list (Orders tab). */
export function OrdersTable({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  const locale = useLocale();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-normal">{t('admin.overview.tabOrders')}</CardTitle>
        <CardAction>
          <span className="text-xs text-muted-foreground">
            {t('admin.overview.ordersTotal', { count: data.orderRows.length })}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('admin.overview.colOrderId')}</TableHead>
              <TableHead>{t('admin.overview.colCustomer')}</TableHead>
              <TableHead className="text-right">{t('admin.overview.colItems')}</TableHead>
              <TableHead className="text-right">{t('admin.overview.colAmount')}</TableHead>
              <TableHead>{t('admin.overview.colStatus')}</TableHead>
              <TableHead className="text-right">{t('admin.overview.colCreatedAt')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.orderRows.length ? (
              data.orderRows.map((order) => (
                <TableRow key={order.id}>
                  <TableCell className="font-mono text-xs">
                    {order.id.slice(-8).toUpperCase()}
                  </TableCell>
                  <TableCell className="max-w-56 truncate">
                    {order.customer || t('admin.overview.customerFallback')}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(order.itemCount, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatYuan(order.total, locale)}
                  </TableCell>
                  <TableCell>{orderStatusLabel(order.status, t)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatDate(new Date(order.createdAt), locale, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                  {t('admin.overview.noData')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

const PRODUCT_STATUS_KEYS: Record<string, string> = {
  ACTIVE: 'admin.overview.productStatusActive',
  INACTIVE: 'admin.overview.productStatusInactive',
  DRAFT: 'admin.overview.productStatusDraft',
};

function productStatusLabel(status: string, t: Translator): string {
  const key = PRODUCT_STATUS_KEYS[status];
  return key ? t(key) : status;
}

/** Full product list (Products tab). */
export function ProductsTable({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  const locale = useLocale();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-normal">{t('admin.overview.tabProducts')}</CardTitle>
        <CardAction>
          <span className="text-xs text-muted-foreground">
            {t('admin.overview.productsTotal', { count: data.productRows.length })}
          </span>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('admin.overview.colProduct')}</TableHead>
              <TableHead className="text-right">{t('admin.overview.colPrice')}</TableHead>
              <TableHead className="text-right">{t('admin.overview.colStock')}</TableHead>
              <TableHead>{t('admin.overview.colStatus')}</TableHead>
              <TableHead className="text-right">{t('admin.overview.colCreatedAt')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.productRows.length ? (
              data.productRows.map((product) => (
                <TableRow key={product.id}>
                  <TableCell className="max-w-64 truncate font-medium">{product.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(product.price / 100, product.currency, locale, {
                      maximumFractionDigits: 0,
                    })}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(product.stock, locale)}
                  </TableCell>
                  <TableCell>{productStatusLabel(product.status, t)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {formatDate(new Date(product.createdAt), locale, { dateStyle: 'medium' })}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  {t('admin.overview.noData')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
