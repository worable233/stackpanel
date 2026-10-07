'use client';

import Link from 'next/link';
import { RotateCw, Settings2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@stackpanel/ui';
import type { AdminOverviewData } from '@/lib/admin-overview-types';
import { useLocale, useTranslator } from '@/i18n/provider';
import { formatDate } from '@/i18n/core';

import {
  OrderStatusCard,
  OrdersTable,
  OrderSummaryNote,
  OverviewKpis,
  ProductsTable,
  QuickActions,
  RecentOrdersCard,
  RecentUsersCard,
  RevenueSources,
  RevenueTrendCard,
} from './admin-finance/sections';

/**
 * Admin dashboard body. Composition mirrors the open-source Studio Admin
 * finance dashboard (arhamkhnz/next-shadcn-admin-dashboard, finance route):
 * a title + date header, a line-tab row with trailing actions, then three
 * 12-column grids (metrics / top products, trend / order status, recent
 * orders / recent users / shortcuts). The tabs bind to real StackPanel
 * orders and products. Components (`OverviewKpis`, `RevenueSources`,
 * `OrderSummaryNote`, `RevenueTrendCard`, `OrderStatusCard`,
 * `RecentOrdersCard`, `RecentUsersCard`, `QuickActions`, `OrdersTable`,
 * `ProductsTable`) reuse the same base-nova shadcn primitives.
 */
export function AdminOverview({ data }: { data: AdminOverviewData }) {
  const t = useTranslator();
  const locale = useLocale();
  const today = formatDate(new Date(), locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('nav.dashboard')} description={today} />

      <Tabs defaultValue="overview" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <TabsList variant="line">
            <TabsTrigger value="overview">{t('admin.overview.tabOverview')}</TabsTrigger>
            <TabsTrigger value="orders">{t('admin.overview.tabOrders')}</TabsTrigger>
            <TabsTrigger value="products">{t('admin.overview.tabProducts')}</TabsTrigger>
          </TabsList>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RotateCw className="size-4" />
              <span>{t('admin.overview.updatedJustNow')}</span>
            </div>
            <Button size="sm" variant="outline" render={<Link href="/admin/settings" />}>
              <Settings2 />
              {t('admin.overview.settings')}
            </Button>
          </div>
        </div>

        <TabsContent value="overview" className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <div className="xl:col-span-6">
              <OverviewKpis data={data} />
            </div>
            <div className="flex flex-col gap-4 xl:col-span-6">
              <RevenueSources data={data} />
              <OrderSummaryNote data={data} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <div className="xl:col-span-7">
              <RevenueTrendCard data={data} />
            </div>
            <div className="xl:col-span-5">
              <OrderStatusCard data={data} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <div className="xl:col-span-4">
              <RecentOrdersCard data={data} />
            </div>
            <div className="xl:col-span-4">
              <RecentUsersCard data={data} />
            </div>
            <div className="xl:col-span-4">
              <QuickActions data={data} />
            </div>
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
