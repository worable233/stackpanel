/**
 * StatusBadge - 系统运行状态徽章
 *
 * Copy-free presentational primitive: the caller supplies the already-localised
 * label (ADR-0016). Keeping copy out of the component lets the kernel, themes
 * and plugins share it without a hard dependency on any message catalog.
 */

import { cn } from '@/lib/utils';

export type StatusType = 'operational' | 'degraded' | 'maintenance' | 'outage';

export interface StatusBadgeProps {
  /** 状态类型 */
  status?: StatusType;
  /** 已本地化的状态文本 */
  label: string;
  /** 自定义类名 */
  className?: string;
}

const statusConfig: Record<
  StatusType,
  {
    dotColor: string;
    pingColor: string;
  }
> = {
  operational: {
    dotColor: 'bg-green-500',
    pingColor: 'bg-green-400',
  },
  degraded: {
    dotColor: 'bg-yellow-500',
    pingColor: 'bg-yellow-400',
  },
  maintenance: {
    dotColor: 'bg-blue-500',
    pingColor: 'bg-blue-400',
  },
  outage: {
    dotColor: 'bg-red-500',
    pingColor: 'bg-red-400',
  },
};

export function StatusBadge({ status = 'operational', label, className }: StatusBadgeProps) {
  const config = statusConfig[status];

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
      <span className="font-medium text-neutral-700 dark:text-neutral-300">{label}</span>
    </div>
  );
}
