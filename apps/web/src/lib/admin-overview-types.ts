import { formatCurrency, type Locale } from '@/i18n';

export interface AdminOverviewData {
  range: { from: string | null; to: string | null };
  totals: {
    revenue: number;
    orderCount: number;
    pendingCount: number;
    userCount: number;
    walletBalance: number;
    productCount: number;
    activeProductCount: number;
    walletAccountCount: number;
  };
  deltas: {
    revenuePct: number | null;
    orderPct: number | null;
    userPct: number | null;
    walletPct: number | null;
  };
  revenueSeries: Array<{ month: string; paid: number; pipeline: number }>;
  weekSeries: Array<{ day: string; revenue: number }>;
  statusBreakdown: Array<{ status: string; value: number }>;
  sourceBreakdown: Array<{ name: string; value: number }>;
  topProducts: Array<{ name: string; sales: number; revenue: number }>;
  recentOrders: Array<{
    id: string;
    customer: string;
    product: string;
    total: number;
    status: string;
    createdAt: string;
  }>;
  recentEvents: Array<{
    time: string;
    orderId: string;
    status: string;
  }>;
}

/** Money is stored in fen; render a locale-aware CNY amount (ADR-0016 §6). */
export function formatYuan(amount: number, locale: Locale = 'zh-CN'): string {
  return formatCurrency(amount / 100, 'CNY', locale, { maximumFractionDigits: 0 });
}
