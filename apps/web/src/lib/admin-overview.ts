import 'server-only';

import { z } from 'zod';

import { getAuthedApiClient } from './api';
import type { AdminOverviewData } from './admin-overview-types';

const orderSchema = z.object({
  id: z.string(),
  userId: z.string(),
  items: z.unknown(),
  total: z.number(),
  currency: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

const ordersResponseSchema = z.object({
  orders: z.array(orderSchema),
  total: z.number(),
});

async function fetchAllOrders(api: Awaited<ReturnType<typeof getAuthedApiClient>>) {
  const PAGE_SIZE = 100;
  const all: Array<z.infer<typeof orderSchema>> = [];
  const first = await api.get(
    `/store/admin/orders?page=1&pageSize=${PAGE_SIZE}`,
    ordersResponseSchema,
  );
  all.push(...first.orders);
  const pages = Math.ceil(first.total / PAGE_SIZE);
  for (let page = 2; page <= pages; page += 1) {
    const res = await api.get(
      `/store/admin/orders?page=${page}&pageSize=${PAGE_SIZE}`,
      ordersResponseSchema,
    );
    all.push(...res.orders);
  }
  return all;
}

const walletsResponseSchema = z.object({
  accounts: z.array(
    z.object({
      userId: z.string(),
      email: z.string(),
      balance: z.number(),
      currency: z.string(),
    }),
  ),
});

const usersResponseSchema = z.object({
  users: z.array(z.object({ id: z.string(), email: z.string(), createdAt: z.string() })),
  total: z.number(),
});

const productsResponseSchema = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      price: z.number(),
      currency: z.string(),
      stock: z.number(),
      status: z.string(),
      fulfillmentType: z.string(),
      createdAt: z.string(),
    }),
  ),
  total: z.number(),
});

const MONTH_KEYS = Array.from({ length: 12 }, (_, i) => {
  const d = new Date();
  d.setMonth(d.getMonth() - (11 - i));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
});

const WEEK_KEYS = Array.from({ length: 7 }, (_, i) => {
  const d = new Date();
  d.setDate(d.getDate() - (6 - i));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function extractItems(items: unknown): Array<{ name: string; price: number; quantity: number }> {
  if (!items || typeof items !== 'object') return [];
  const obj = items as { items?: unknown };
  if (!Array.isArray(obj.items)) return [];
  return obj.items
    .filter(
      (it): it is { name: string; price: number; quantity: number } =>
        !!it &&
        typeof it === 'object' &&
        typeof (it as { name?: unknown }).name === 'string' &&
        typeof (it as { price?: unknown }).price === 'number',
    )
    .map((it) => ({
      name: it.name,
      price: it.price,
      quantity: typeof it.quantity === 'number' ? it.quantity : 1,
    }));
}

function inRange(iso: string, from: string | null, to: string | null): boolean {
  const day = iso.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

function buildRangeDays(from: string | null, to: string | null): string[] {
  const end = to ?? WEEK_KEYS[WEEK_KEYS.length - 1];
  const start = from ?? WEEK_KEYS[0];
  if (start > end) return [];
  const days: string[] = [];
  const cursor = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);
  while (cursor <= last) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, '0');
    const d = String(cursor.getDate()).padStart(2, '0');
    days.push(`${y}-${m}-${d}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export interface AdminOverviewRange {
  from: string | null;
  to: string | null;
}

export async function loadAdminOverview(
  range: AdminOverviewRange = { from: null, to: null },
): Promise<AdminOverviewData> {
  const api = await getAuthedApiClient();

  const [orders, walletsRes, usersRes, productsRes] = await Promise.all([
    fetchAllOrders(api),
    api.get('/store/admin/wallets', walletsResponseSchema),
    api.get('/admin/users?page=1&pageSize=100', usersResponseSchema),
    api.get('/store/admin/products?page=1&pageSize=100', productsResponseSchema),
  ]);

  const paid = orders.filter((o) => o.status === 'PAID');

  const revenue = paid.reduce((sum, o) => sum + o.total, 0);

  const revenueSeries = MONTH_KEYS.map((key) => ({
    month: key,
    paid: paid.filter((o) => monthKey(o.createdAt) === key).reduce((s, o) => s + o.total, 0),
    pipeline: orders
      .filter((o) => monthKey(o.createdAt) === key && o.status !== 'CANCELLED')
      .reduce((s, o) => s + o.total, 0),
  }));

  const statusCounts = new Map<string, number>();
  for (const o of orders) {
    statusCounts.set(o.status, (statusCounts.get(o.status) ?? 0) + 1);
  }
  const statusBreakdown = Array.from(statusCounts.entries())
    .map(([status, value]) => ({ status, value }))
    .sort((a, b) => b.value - a.value);

  const rangeOrders = orders.filter((o) => inRange(o.createdAt, range.from, range.to));
  const rangePaid = rangeOrders.filter((o) => o.status === 'PAID');

  const rangeDays = buildRangeDays(range.from, range.to);
  const weekSeries = rangeDays.map((key) => ({
    day: key,
    revenue: rangePaid.filter((o) => dayKey(o.createdAt) === key).reduce((s, o) => s + o.total, 0),
    pipeline: rangeOrders
      .filter((o) => dayKey(o.createdAt) === key && o.status !== 'CANCELLED')
      .reduce((s, o) => s + o.total, 0),
  }));

  const paidRevenue = rangePaid.reduce((s, o) => s + o.total, 0);

  const productStats = new Map<string, { sales: number; revenue: number }>();
  for (const o of rangePaid) {
    for (const item of extractItems(o.items)) {
      const cur = productStats.get(item.name) ?? { sales: 0, revenue: 0 };
      cur.sales += item.quantity;
      cur.revenue += item.price * item.quantity;
      productStats.set(item.name, cur);
    }
  }
  const topProducts = Array.from(productStats.entries())
    .map(([name, v]) => ({
      name,
      ...v,
      pct: paidRevenue > 0 ? Math.round((v.revenue / paidRevenue) * 100) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  const walletBalance = walletsRes.accounts.reduce((s, a) => s + a.balance, 0);

  const recentUsers = [...usersRes.users]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5)
    .map((u) => ({ id: u.id, email: u.email, createdAt: u.createdAt }));

  const emailById = new Map(usersRes.users.map((u) => [u.id, u.email]));

  const thisMonthKey = MONTH_KEYS[MONTH_KEYS.length - 1];
  const lastMonthKey = MONTH_KEYS[MONTH_KEYS.length - 2];
  const thisMonthRevenue = revenueSeries.find((s) => s.month === thisMonthKey)?.paid ?? 0;
  const lastMonthRevenue = revenueSeries.find((s) => s.month === lastMonthKey)?.paid ?? 0;
  const thisMonthOrders = orders.filter((o) => monthKey(o.createdAt) === thisMonthKey).length;
  const lastMonthOrders = orders.filter((o) => monthKey(o.createdAt) === lastMonthKey).length;
  const thisMonthUsers = usersRes.users.filter(
    (u) => monthKey(u.createdAt) === thisMonthKey,
  ).length;
  const lastMonthUsers = usersRes.users.filter(
    (u) => monthKey(u.createdAt) === lastMonthKey,
  ).length;

  const pct = (current: number, previous: number): number | null => {
    if (previous <= 0) return current > 0 ? null : null;
    return ((current - previous) / previous) * 100;
  };

  const recentOrders = [...rangeOrders]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 6)
    .map((o) => {
      const items = extractItems(o.items);
      return {
        id: o.id.slice(-6).toUpperCase(),
        customer: emailById.get(o.userId) ?? '',
        product: items.map((it) => it.name).join('、') || '-',
        total: o.total,
        status: o.status,
        createdAt: o.createdAt,
      };
    });

  const monthOrders = orders.filter((o) => monthKey(o.createdAt) === thisMonthKey);

  const orderRows = [...orders]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((o) => ({
      id: o.id,
      customer: emailById.get(o.userId) ?? '',
      itemCount: extractItems(o.items).reduce((s, it) => s + it.quantity, 0),
      total: o.total,
      status: o.status,
      createdAt: o.createdAt,
    }));

  const productRows = productsRes.products.map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    currency: p.currency,
    stock: p.stock,
    status: p.status,
    fulfillmentType: p.fulfillmentType,
    createdAt: p.createdAt,
  }));

  return {
    range: { from: range.from, to: range.to },
    totals: {
      revenue,
      orderCount: orders.length,
      userCount: usersRes.total,
      walletBalance,
      productCount: productsRes.total,
      activeProductCount: productsRes.products.filter((p) => p.status === 'ACTIVE').length,
      walletAccountCount: walletsRes.accounts.length,
      monthOrderCount: monthOrders.length,
      monthOrderAmount: monthOrders.reduce((s, o) => s + o.total, 0),
      paidOrderCount: paid.length,
    },
    deltas: {
      revenuePct: pct(thisMonthRevenue, lastMonthRevenue),
      orderPct: pct(thisMonthOrders, lastMonthOrders),
      userPct: pct(thisMonthUsers, lastMonthUsers),
      walletPct: null,
    },
    revenueSeries,
    weekSeries,
    statusBreakdown,
    topProducts,
    recentOrders,
    recentUsers,
    orderRows,
    productRows,
  };
}
