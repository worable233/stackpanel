/**
 * StatusBadge - 状态指示徽章
 * 
 * 用于显示系统运行状态，带动画效果的指示灯
 */

import { cn } from '@/lib/utils';

export type StatusType = 'operational' | 'degraded' | 'maintenance' | 'outage';

export interface StatusBadgeProps {
  /** 状态类型 */
  status?: StatusType;
  /** 自定义状态文本 */
  label?: string;
  /** 自定义类名 */
  className?: string;
}

const statusConfig: Record<
  StatusType,
  {
    label: string;
    dotColor: string;
    pingColor: string;
  }
> = {
  operational: {
    label: '所有服务正常运行',
    dotColor: 'bg-green-500',
    pingColor: 'bg-green-400',
  },
  degraded: {
    label: '部分服务性能下降',
    dotColor: 'bg-yellow-500',
    pingColor: 'bg-yellow-400',
  },
  maintenance: {
    label: '系统维护中',
    dotColor: 'bg-blue-500',
    pingColor: 'bg-blue-400',
  },
  outage: {
    label: '服务暂时不可用',
    dotColor: 'bg-red-500',
    pingColor: 'bg-red-400',
  },
};

export function StatusBadge({ status = 'operational', label, className }: StatusBadgeProps) {
  const config = statusConfig[status];
  const displayLabel = label || config.label;

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2.5 rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm shadow-sm',
        'dark:border-neutral-800 dark:bg-neutral-900',
        className,
      )}
    >
      {/* 动画指示灯 */}
      <span className="relative flex size-2.5">
        {/* Ping 动画 */}
        <span
          className={cn(
            'absolute inline-flex size-full animate-ping rounded-full opacity-75',
            config.pingColor,
          )}
        />
        {/* 实心圆点 */}
        <span className={cn('relative inline-flex size-2.5 rounded-full', config.dotColor)} />
      </span>

      {/* 状态文本 */}
      <span className="font-medium text-neutral-700 dark:text-neutral-300">{displayLabel}</span>
    </div>
  );
}
