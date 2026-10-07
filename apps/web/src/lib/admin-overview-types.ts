import { formatCurrency, type Locale } from '@/i18n';

/**
 * Aggregated admin dashboard payload. Everything is derived from real platform
 * data (orders / wallets / users / products) so the finance-style dashboard
 * shows StockPanel metrics rather than generic placeholders.
 */
export interface AdminOverviewData {
  range: { from: string | null; to: string | null };
  totals: {
    revenue: number;
    orderCount: number;
    userCount: number;
    walletBalance: number;
    productCount: number;
    activeProductCount: number;
    walletAccountCount: number;
    /** Orders created in the current month (all statuses). */
    monthOrderCount: number;
    /** Gross amount of orders created in the current month (all statuses). */
    monthOrderAmount: number;
    /** Paid orders across the whole period. */
    paidOrderCount: number;
  };
  deltas: {
    revenuePct: number | null;
    orderPct: number | null;
    userPct: number | null;
    walletPct: number | null;
  };
  /** Monthly revenue: paid vs. all non-cancelled orders. */
  revenueSeries: Array<{ month: string; paid: number; pipeline: number }>;
  /** Daily revenue for the selected range: paid vs. all non-cancelled orders. */
  weekSeries: Array<{ day: string; revenue: number; pipeline: number }>;
  /** Order count grouped by status (drives the status donut). */
  statusBreakdown: Array<{ status: string; value: number }>;
  /** Best-selling products by revenue with their share of paid revenue. */
  topProducts: Array<{ name: string; sales: number; revenue: number; pct: number }>;
  /** Most recent orders in range, newest first. */
  recentOrders: Array<{
    id: string;
    customer: string;
    product: string;
    total: number;
    status: string;
    createdAt: string;
  }>;
  /** Most recently registered users, newest first. */
  recentUsers: Array<{
    id: string;
    email: string;
    createdAt: string;
  }>;
  /** All orders, newest first (Orders tab). */
  orderRows: Array<{
    id: string;
    customer: string;
    itemCount: number;
    total: number;
    status: string;
    createdAt: string;
  }>;
  /** All products (Products tab). */
  productRows: Array<{
    id: string;
    name: string;
    price: number;
    currency: string;
    stock: number;
    status: string;
    fulfillmentType: string;
    createdAt: string;
  }>;
}

/** Money is stored in fen; render a locale-aware CNY amount (ADR-0016 §6). */
export function formatYuan(amount: number, locale: Locale = 'zh-CN'): string {
  return formatCurrency(amount / 100, 'CNY', locale, { maximumFractionDigits: 0 });
}
