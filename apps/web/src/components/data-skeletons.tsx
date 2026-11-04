import type { CSSProperties, ReactElement } from 'react';

import { Skeleton } from '@/components/ui/skeleton';

/**
 * Data-only skeletons.
 *
 * Route-level `loading.tsx` replaces the whole page while the first RSC shell is
 * prepared. Once the static shell is on screen, each data region uses one of
 * these instead, so headings, filters, tabs and buttons stay readable while the
 * rows behind them stream in independently.
 */
export type DataSkeletonVariant =
  | 'cards'
  | 'dashboard'
  | 'detail'
  | 'developer'
  | 'inbox'
  | 'list'
  | 'plugins'
  | 'settings'
  | 'table'
  | 'themes'
  | 'updates';

function Block({ className, style }: { className?: string; style?: CSSProperties }): ReactElement {
  return <Skeleton className={className} style={style} />;
}

function CardRows({ rows = 4 }: { rows?: number }): ReactElement {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="rounded-2xl bg-muted/40 p-5">
          <Block className="h-3.5 w-20 bg-muted/70" />
          <Block className="mt-3 h-8 w-24" />
          <Block className="mt-3 h-3 w-28 bg-muted/70" />
        </div>
      ))}
    </div>
  );
}

function ListRows({
  rows = 6,
  compact = false,
}: {
  rows?: number;
  compact?: boolean;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={
            compact
              ? 'flex items-center gap-3 rounded-2xl bg-muted/40 px-4 py-3'
              : 'flex flex-wrap items-center gap-3 rounded-2xl bg-muted/40 px-4 py-3.5'
          }
        >
          <Block className="size-9 shrink-0 rounded-xl" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Block className="h-4 w-2/5" />
            <Block className="h-3 w-1/3 bg-muted/70" />
          </div>
          <Block className="h-6 w-16 rounded-full" />
          <Block className="h-8 w-8 rounded-lg" />
        </div>
      ))}
    </div>
  );
}

function Panel({ rows = 4 }: { rows?: number }): ReactElement {
  return (
    <div className="rounded-2xl bg-muted/40 p-5">
      <div className="flex items-center justify-between gap-3">
        <Block className="h-5 w-32" />
        <Block className="h-8 w-20 rounded-lg" />
      </div>
      <div className="mt-4 flex flex-col gap-2.5">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3 rounded-xl bg-background/70 p-3.5">
            <Block className="size-8 shrink-0 rounded-lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Block className="h-3.5 w-1/2" />
              <Block className="h-3 w-1/3 bg-muted/70" />
            </div>
            <Block className="h-3 w-12 bg-muted/70" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartPanel(): ReactElement {
  return (
    <div className="rounded-2xl bg-muted/40 p-5">
      <div className="flex items-center justify-between gap-3">
        <Block className="h-5 w-28" />
        <Block className="h-5 w-16 rounded-full bg-muted/70" />
      </div>
      <div className="mt-5 flex h-56 items-end gap-2 rounded-xl bg-background/60 px-4 pb-4">
        {[28, 44, 36, 58, 50, 66, 42, 72, 56, 64, 48, 76].map((height, index) => (
          <Block key={index} className="w-full rounded-t-lg" style={{ height: `${height}%` }} />
        ))}
      </div>
    </div>
  );
}

function SettingsPanel(): ReactElement {
  return (
    <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-2 rounded-2xl bg-muted/30 p-2">
        {Array.from({ length: 7 }, (_, index) => (
          <Block key={index} className="h-9 rounded-xl bg-muted/60" />
        ))}
      </div>
      <div className="flex flex-col gap-4">
        <div className="rounded-2xl bg-muted/40 p-6">
          <Block className="h-6 w-36" />
          <Block className="mt-2 h-3.5 w-64 bg-muted/70" />
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="flex flex-col gap-2">
                <Block className="h-3.5 w-20 bg-muted/70" />
                <Block className="h-10 rounded-[10px] bg-background" />
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl bg-muted/40 p-6">
          <Block className="h-5 w-28" />
          <Block className="mt-4 h-10 w-40 rounded-[10px]" />
        </div>
      </div>
    </div>
  );
}

function UpdatesPanel(): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl bg-muted/40 p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Block className="h-3.5 w-20 bg-muted/70" />
            <Block className="h-9 w-32" />
            <Block className="h-3.5 w-48 bg-muted/70" />
          </div>
          <Block className="h-10 w-32 rounded-[10px]" />
        </div>
      </div>
      <div className="rounded-2xl bg-muted/30 p-5">
        <Block className="h-4 w-40" />
        <Block className="mt-3 h-3.5 w-72 bg-muted/70" />
      </div>
    </div>
  );
}

export function DataSkeleton({
  variant = 'list',
  rows,
  className,
}: {
  variant?: DataSkeletonVariant;
  rows?: number;
  className?: string;
}): ReactElement {
  switch (variant) {
    case 'cards':
      return <CardRows rows={rows ?? 4} />;
    case 'dashboard':
      return (
        <div className={className ?? 'flex flex-col gap-6'}>
          <CardRows />
          <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
            <ChartPanel />
            <Panel />
          </div>
        </div>
      );
    case 'detail':
      return (
        <div className={className ?? 'flex flex-col gap-4'}>
          <CardRows rows={2} />
          <Panel rows={5} />
        </div>
      );
    case 'developer':
      return (
        <div className={className ?? 'flex flex-col gap-6'}>
          <CardRows />
          <div className="grid gap-4 sm:grid-cols-2">
            <Panel rows={2} />
            <Panel rows={2} />
          </div>
          <Panel rows={rows ?? 4} />
        </div>
      );
    case 'inbox':
      return <ListRows rows={rows ?? 6} compact />;
    case 'plugins':
    case 'themes':
      return <ListRows rows={rows ?? 6} compact />;
    case 'settings':
      return <SettingsPanel />;
    case 'table':
      return (
        <div className={className ?? 'flex flex-col gap-2.5'}>
          <div className="flex items-center gap-3 px-4 py-2">
            <Block className="h-3.5 w-28 bg-muted/70" />
            <Block className="h-3.5 w-20 bg-muted/70" />
            <Block className="h-3.5 w-20 bg-muted/70" />
            <Block className="ml-auto h-3.5 w-14 bg-muted/70" />
          </div>
          <ListRows rows={rows ?? 8} compact />
        </div>
      );
    case 'updates':
      return <UpdatesPanel />;
    case 'list':
    default:
      return <ListRows rows={rows ?? 6} />;
  }
}
