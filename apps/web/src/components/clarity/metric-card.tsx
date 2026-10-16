/**
 * MetricCard - 数据指标卡片
 *
 * 用于展示关键数据指标，带可选的趋势指示器
 */

import type { LucideIcon } from 'lucide-react';
import { TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface MetricCardProps {
  /** 主要数值 */
  value: string | number;
  /** 标签描述 */
  label: string;
  /** 趋势百分比（如 "+12%"） */
  trend?: string;
  /** 图标组件 */
  icon?: LucideIcon;
  /** 是否处于加载状态 */
  loading?: boolean;
  /** 自定义类名 */
  className?: string;
}

export function MetricCard({
  value,
  label,
  trend,
  icon: Icon,
  loading = false,
  className,
}: MetricCardProps) {
  if (loading) {
    return <MetricCardSkeleton className={className} />;
  }

  const isPositiveTrend = trend?.startsWith('+');
  const isNegativeTrend = trend?.startsWith('-');

  return (
    <div
      className={cn(
        'group rounded-xl border border-border bg-card p-6 text-card-foreground transition duration-300 motion-reduce:transition-none',
        'hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5',
        className,
      )}
    >
      {/* 顶部：图标和趋势 */}
      <div className="mb-3 flex items-center justify-between">
        {Icon && (
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Icon className="size-5" />
          </div>
        )}
        {trend && (
          <div
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
              {
                'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400':
                  isPositiveTrend,
                'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400': isNegativeTrend,
                'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-400':
                  !isPositiveTrend && !isNegativeTrend,
              },
            )}
          >
            {isPositiveTrend && <TrendingUp className="size-3" />}
            {trend}
          </div>
        )}
      </div>

      {/* 主要数值 */}
      <div className="mb-1 text-3xl font-bold tabular-nums text-neutral-900 dark:text-white">
        {value}
      </div>

      {/* 标签 */}
      <div className="text-sm text-neutral-600 dark:text-neutral-400">{label}</div>
    </div>
  );
}

/**
 * 骨架屏加载状态
 */
function MetricCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-lg border border-neutral-200 bg-white p-6',
        'dark:border-neutral-800 dark:bg-neutral-950',
        className,
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="size-9 rounded-lg bg-neutral-200 dark:bg-neutral-800" />
        <div className="h-5 w-12 rounded-full bg-neutral-200 dark:bg-neutral-800" />
      </div>
      <div className="mb-2 h-9 w-24 rounded bg-neutral-200 dark:bg-neutral-800" />
      <div className="h-4 w-32 rounded bg-neutral-200 dark:bg-neutral-800" />
    </div>
  );
}

MetricCard.Skeleton = MetricCardSkeleton;
