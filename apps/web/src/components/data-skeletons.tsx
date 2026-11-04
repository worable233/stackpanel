import type { CSSProperties, ReactElement } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

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

/**
 * Phone rows wrap into a title line plus meta lines, so their height depends on
 * how much metadata the real record carries and cannot be derived from the
 * desktop layout. Each variant therefore pins the height its rows actually
 * occupy at 390px (measured against the live pages) — otherwise the list jumps
 * and the scroll position snaps when the data lands.
 */
const ROW_HEIGHT: Record<string, string> = {
  audit: 'min-h-[120px] sm:min-h-0',
  inbox: 'min-h-[146px] sm:min-h-0',
  list: 'min-h-[118px] sm:min-h-0',
  payments: 'min-h-[114px] sm:min-h-0',
  plugins: 'min-h-[128px] sm:min-h-0',
  rbac: 'min-h-[132px] sm:min-h-0',
  seo: 'min-h-[118px] sm:min-h-0',
  table: 'min-h-[148px] sm:min-h-0',
  themes: 'min-h-[132px] sm:min-h-0',
};

function ListRows({
  rows = 6,
  rowHeight = 'list',
  meta = 1,
}: {
  rows?: number;
  rowHeight?: keyof typeof ROW_HEIGHT;
  meta?: number;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={cn(
            'flex flex-col gap-3 rounded-2xl bg-muted/40 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3 sm:py-3.5',
            ROW_HEIGHT[rowHeight],
          )}
        >
          <div className="flex items-center gap-3">
            <Block className="size-9 shrink-0 rounded-xl" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Block className="h-4 w-2/5" />
              <Block className="h-3 w-1/3 bg-muted/70" />
            </div>
            <Block className="h-6 w-16 shrink-0 rounded-full" />
            <Block className="hidden size-8 shrink-0 rounded-lg sm:block" />
          </div>
          {/* Records carry a metadata line at every width; phones wrap it more. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {Array.from({ length: meta }, (_, line) => (
              <Block
                key={line}
                className={line === 0 ? 'h-5 w-16 rounded-full' : 'h-3 bg-muted/70'}
                style={{ width: [104, 72, 84][line % 3] }}
              />
            ))}
          </div>
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
      {/* Phones get the section picker, not the vertical rail (see SettingsSections). */}
      <Block className="h-12 rounded-xl bg-muted/40 lg:hidden" />
      <div className="hidden flex-col gap-2 rounded-2xl bg-muted/30 p-2 lg:flex">
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
  rowHeight = 'list',
  className,
}: {
  variant?: DataSkeletonVariant;
  rows?: number;
  /**
   * Row shape for the `list` variant. Record height on phones depends on how
   * many metadata lines a row carries, which the component cannot infer from
   * the variant name — audit rows, payment rows and rbAC rows all render
   * through `variant="list"` but stack differently at 390px.
   */
  rowHeight?: keyof typeof ROW_HEIGHT;
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
      return <ListRows rows={rows ?? 6} rowHeight="inbox" meta={6} />;
    case 'plugins':
      return <ListRows rows={rows ?? 6} rowHeight="plugins" meta={4} />;
    case 'themes':
      return <ListRows rows={rows ?? 6} rowHeight="themes" meta={5} />;
    case 'settings':
      return <SettingsPanel />;
    case 'table':
      return (
        <div className={className ?? 'flex flex-col gap-2.5'}>
          <div className="hidden items-center gap-3 px-4 py-2 sm:flex">
            <Block className="h-3.5 w-28 bg-muted/70" />
            <Block className="h-3.5 w-20 bg-muted/70" />
            <Block className="h-3.5 w-20 bg-muted/70" />
            <Block className="ml-auto h-3.5 w-14 bg-muted/70" />
          </div>
          <ListRows rows={rows ?? 8} rowHeight="table" meta={5} />
        </div>
      );
    case 'updates':
      return <UpdatesPanel />;
    case 'list':
    default:
      return <ListRows rows={rows ?? 6} rowHeight={rowHeight} />;
  }
}
