import type { CSSProperties, ReactElement } from 'react';

import { Skeleton } from '@/components/ui/skeleton';

export type PageSkeletonVariant =
  | 'account'
  | 'agent'
  | 'agent-run'
  | 'auth'
  | 'dashboard'
  | 'detail'
  | 'developer'
  | 'list'
  | 'nav'
  | 'notifications'
  | 'plugins'
  | 'public'
  | 'rbac'
  | 'seo'
  | 'settings'
  | 'themes'
  | 'updates'
  | 'user-detail';

function Block({ className, style }: { className?: string; style?: CSSProperties }): ReactElement {
  return <Skeleton className={className} style={style} />;
}

function Heading({
  action = true,
  description = true,
}: {
  action?: boolean;
  description?: boolean;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-2">
        <Block className="h-7 w-40 max-w-[60vw]" />
        {description ? <Block className="h-4 w-64 max-w-[70vw]" /> : null}
      </div>
      {action ? <Block className="h-9 w-28 rounded-xl" /> : null}
    </div>
  );
}

function Toolbar(): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Block className="h-9 min-w-48 flex-1 rounded-xl" />
      <Block className="h-9 w-24 rounded-xl" />
      <Block className="h-9 w-24 rounded-xl" />
    </div>
  );
}

function ListRows({ rows = 6 }: { rows?: number }): ReactElement {
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex flex-wrap items-center gap-3 rounded-2xl bg-muted/40 px-4 py-3.5"
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

function MetricCards({ count = 4 }: { count?: number }): ReactElement {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-2xl bg-muted/40 p-5">
          <Block className="h-3.5 w-20 bg-muted/70" />
          <Block className="mt-3 h-8 w-24" />
          <Block className="mt-3 h-3 w-28 bg-muted/70" />
        </div>
      ))}
    </div>
  );
}

function Panel({ className }: { className?: string }): ReactElement {
  return (
    <div className={className ?? 'rounded-2xl bg-muted/40 p-5'}>
      <div className="flex items-center justify-between gap-3">
        <Block className="h-5 w-32" />
        <Block className="h-8 w-20 rounded-lg" />
      </div>
      <div className="mt-4 flex flex-col gap-2.5">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3 rounded-xl bg-background/70 p-3.5">
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

function DashboardSkeleton(): ReactElement {
  return (
    <>
      <Heading />
      <MetricCards />
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="rounded-2xl bg-muted/40 p-5">
          <div className="flex items-center justify-between">
            <Block className="h-5 w-32" />
            <Block className="h-3 w-20 bg-muted/70" />
          </div>
          <div className="mt-5 flex h-56 items-end gap-3">
            {[38, 56, 44, 72, 52, 84, 64, 90, 70, 96, 78, 62].map((height, index) => (
              <Block key={index} className="flex-1 rounded-t-lg" style={{ height: `${height}%` }} />
            ))}
          </div>
        </div>
        <Panel />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel />
        <Panel />
      </div>
    </>
  );
}

function ListSkeleton(): ReactElement {
  return (
    <>
      <Heading />
      <Toolbar />
      <ListRows />
      <div className="flex items-center justify-between">
        <Block className="h-4 w-28 bg-muted/70" />
        <div className="flex gap-2">
          <Block className="h-8 w-8 rounded-lg" />
          <Block className="h-8 w-8 rounded-lg" />
          <Block className="h-8 w-8 rounded-lg" />
        </div>
      </div>
    </>
  );
}

function SettingsSkeleton(): ReactElement {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <Heading />
      <div className="mt-5 flex flex-wrap gap-2">
        {[0, 1, 2, 3].map((tab) => (
          <Block key={tab} className="h-8 w-20 rounded-full" />
        ))}
      </div>
      <div className="mt-5 grid gap-6 lg:grid-cols-[160px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3, 4].map((item) => (
            <Block key={item} className="h-9 w-full rounded-xl" />
          ))}
        </div>
        <div className="rounded-2xl bg-muted/40 p-5">
          <Block className="h-5 w-32" />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="flex flex-col gap-2">
                <Block className="h-3 w-24 bg-muted/70" />
                <Block className="h-9 w-full rounded-[10px]" />
              </div>
            ))}
          </div>
          <div className="mt-5 flex justify-end">
            <Block className="h-9 w-24 rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );
}

function PluginsSkeleton(): ReactElement {
  return (
    <>
      <Heading />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          <Block className="h-9 w-24 rounded-full" />
          <Block className="h-9 w-24 rounded-full" />
        </div>
        <div className="flex gap-2">
          <Block className="h-9 w-48 rounded-xl" />
          <Block className="h-9 w-28 rounded-xl" />
        </div>
      </div>
      <div className="flex flex-col gap-2.5">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="rounded-2xl bg-muted/40 p-4">
            <div className="flex gap-3">
              <Block className="size-10 shrink-0 rounded-xl" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex gap-2">
                  <Block className="h-4 w-32" />
                  <Block className="h-5 w-14 rounded-full" />
                </div>
                <Block className="h-3.5 w-3/5 bg-muted/70" />
                <Block className="h-3 w-2/5 bg-muted/70" />
              </div>
              <Block className="size-8 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ThemesSkeleton(): ReactElement {
  return (
    <>
      <Heading />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((card) => (
          <div key={card} className="overflow-hidden rounded-2xl bg-muted/40">
            <Block className="h-40 w-full rounded-none" />
            <div className="flex flex-col gap-2 p-4">
              <Block className="h-4 w-24" />
              <Block className="h-3 w-40 bg-muted/70" />
              <Block className="mt-2 h-9 w-full rounded-xl" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function UpdatesSkeleton(): ReactElement {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <Heading />
      <div className="mt-6 rounded-2xl bg-muted/40 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Block className="h-7 w-28" />
            <Block className="size-5 rounded-full" />
            <Block className="h-7 w-28" />
          </div>
          <Block className="h-9 w-32 rounded-xl" />
        </div>
        <div className="mt-5 h-px bg-border" />
        <div className="mt-5 flex flex-wrap gap-2">
          <Block className="h-9 w-24 rounded-xl" />
          <Block className="h-9 w-24 rounded-xl" />
        </div>
      </div>
      <div className="mt-4 rounded-2xl bg-muted/30 p-4">
        <div className="flex items-center justify-between gap-3">
          <Block className="h-4 w-48" />
          <Block className="h-8 w-24 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

function DetailSkeleton(): ReactElement {
  return (
    <>
      <Block className="h-4 w-24 bg-muted/70" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Block className="size-12 rounded-2xl" />
          <div className="flex flex-col gap-2">
            <Block className="h-7 w-44" />
            <Block className="h-4 w-56 bg-muted/70" />
          </div>
        </div>
        <div className="flex gap-2">
          <Block className="h-9 w-24 rounded-xl" />
          <Block className="h-9 w-9 rounded-xl" />
        </div>
      </div>
      <MetricCards count={3} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel />
        <Panel />
      </div>
    </>
  );
}

function UserDetailSkeleton(): ReactElement {
  return (
    <>
      <Block className="h-4 w-24 bg-muted/70" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Block className="size-14 rounded-full" />
          <div className="flex flex-col gap-2">
            <Block className="h-7 w-48" />
            <Block className="h-4 w-56 bg-muted/70" />
          </div>
        </div>
        <div className="flex gap-2">
          <Block className="h-9 w-24 rounded-xl" />
          <Block className="h-9 w-32 rounded-xl" />
        </div>
      </div>
      <MetricCards />
      <div className="flex gap-2">
        <Block className="h-9 w-24 rounded-full" />
        <Block className="h-9 w-24 rounded-full" />
        <Block className="h-9 w-24 rounded-full" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel />
        <Panel />
      </div>
    </>
  );
}

function RbacSkeleton(): ReactElement {
  return (
    <>
      <Heading />
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((card) => (
          <div key={card} className="rounded-2xl bg-muted/40 p-5">
            <Block className="h-4 w-24" />
            <Block className="mt-3 h-3 w-36 bg-muted/70" />
            <div className="mt-5 flex flex-wrap gap-1.5">
              <Block className="h-6 w-16 rounded-full" />
              <Block className="h-6 w-20 rounded-full" />
              <Block className="h-6 w-14 rounded-full" />
            </div>
          </div>
        ))}
      </div>
      <ListRows rows={4} />
    </>
  );
}

function NavSkeleton(): ReactElement {
  return (
    <>
      <Heading />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-2xl bg-muted/40 p-4">
          <Block className="h-5 w-32" />
          <div className="mt-4 flex flex-col gap-2">
            {[0, 1, 2, 3, 4, 5].map((row) => (
              <div key={row} className="flex items-center gap-3 rounded-xl bg-background/70 p-3">
                <Block className="size-8 rounded-lg" />
                <Block className="h-4 w-1/3" />
                <Block className="ml-auto h-4 w-14 bg-muted/70" />
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl bg-muted/40 p-4">
          <Block className="h-5 w-28" />
          <div className="mt-4 flex flex-col gap-3">
            {[0, 1, 2, 3].map((field) => (
              <div key={field} className="flex flex-col gap-2">
                <Block className="h-3 w-20 bg-muted/70" />
                <Block className="h-9 w-full rounded-[10px]" />
              </div>
            ))}
            <Block className="h-9 w-24 rounded-xl" />
          </div>
        </div>
      </div>
    </>
  );
}

function DeveloperSkeleton(): ReactElement {
  return (
    <>
      <Heading />
      <div className="flex gap-2">
        <Block className="h-9 w-24 rounded-full" />
        <Block className="h-9 w-24 rounded-full" />
        <Block className="h-9 w-24 rounded-full" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel />
        <Panel />
      </div>
      <ListRows rows={4} />
    </>
  );
}

function NotificationsSkeleton(): ReactElement {
  return (
    <>
      <Heading />
      <div className="flex gap-2">
        <Block className="h-9 w-20 rounded-full" />
        <Block className="h-9 w-20 rounded-full" />
        <Block className="h-9 w-20 rounded-full" />
      </div>
      <ListRows rows={5} />
    </>
  );
}

function SeoSkeleton(): ReactElement {
  return (
    <>
      <Heading />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-2xl bg-muted/40 p-5">
          <div className="flex flex-col gap-4">
            {[0, 1, 2, 3].map((field) => (
              <div key={field} className="flex flex-col gap-2">
                <Block className="h-3 w-24 bg-muted/70" />
                <Block className="h-9 w-full rounded-[10px]" />
              </div>
            ))}
            <div className="flex flex-col gap-2">
              <Block className="h-3 w-24 bg-muted/70" />
              <Block className="h-28 w-full rounded-xl" />
            </div>
          </div>
        </div>
        <div className="rounded-2xl bg-muted/40 p-4">
          <Block className="h-4 w-24" />
          <Block className="mt-4 h-40 w-full rounded-xl" />
          <Block className="mt-4 h-4 w-2/3" />
          <Block className="mt-2 h-3 w-full bg-muted/70" />
        </div>
      </div>
    </>
  );
}

function AgentSkeleton(): ReactElement {
  return (
    <>
      <Heading />
      <MetricCards count={3} />
      <div className="rounded-2xl bg-muted/40 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Block className="h-5 w-28" />
          <div className="flex gap-2">
            <Block className="h-9 w-24 rounded-xl" />
            <Block className="h-9 w-24 rounded-xl" />
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2.5">
          {[0, 1, 2, 3, 4].map((row) => (
            <div
              key={row}
              className="flex flex-wrap items-center gap-3 rounded-xl bg-background/70 p-3.5"
            >
              <Block className="size-8 rounded-lg" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Block className="h-4 w-2/5" />
                <Block className="h-2 w-1/2 rounded-full bg-muted/70" />
              </div>
              <Block className="h-6 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function AgentRunSkeleton(): ReactElement {
  return (
    <>
      <Block className="h-4 w-24 bg-muted/70" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Block className="h-7 w-52" />
          <Block className="h-4 w-64 bg-muted/70" />
        </div>
        <Block className="h-9 w-28 rounded-xl" />
      </div>
      <MetricCards count={3} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-2xl bg-muted/40 p-5">
          <Block className="h-5 w-28" />
          <div className="mt-5 flex flex-col gap-4">
            {[0, 1, 2, 3, 4].map((step) => (
              <div key={step} className="flex gap-3">
                <Block className="size-6 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Block className="h-4 w-1/2" />
                  <Block className="h-3 w-3/4 bg-muted/70" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <Panel />
      </div>
    </>
  );
}

function AccountSkeleton(): ReactElement {
  return (
    <>
      <Heading />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((card) => (
          <div key={card} className="rounded-[14px] bg-muted/55 p-5">
            <Block className="size-9 rounded-xl bg-background" />
            <Block className="mt-4 h-4 w-24" />
            <Block className="mt-2 h-3 w-32 bg-muted/70" />
          </div>
        ))}
      </div>
      <Panel />
    </>
  );
}

function AuthSkeleton(): ReactElement {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm rounded-3xl bg-background p-6">
        <Block className="mx-auto size-10 rounded-xl" />
        <Block className="mx-auto mt-5 h-7 w-40" />
        <Block className="mx-auto mt-2 h-4 w-56 bg-muted/70" />
        <div className="mt-7 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Block className="h-3 w-16 bg-muted/70" />
            <Block className="h-10 w-full rounded-[10px]" />
          </div>
          <div className="flex flex-col gap-2">
            <Block className="h-3 w-20 bg-muted/70" />
            <Block className="h-10 w-full rounded-[10px]" />
          </div>
          <Block className="h-10 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}

function PublicSkeleton(): ReactElement {
  return (
    <div className="w-full bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-12 sm:px-6 lg:py-20">
        <div className="flex flex-col items-center gap-4">
          <Block className="h-6 w-28 rounded-full" />
          <Block className="h-12 w-3/4 max-w-2xl" />
          <Block className="h-12 w-1/2 max-w-xl" />
          <Block className="h-4 w-2/3 max-w-lg bg-muted/70" />
          <div className="mt-2 flex gap-3">
            <Block className="h-10 w-32 rounded-xl" />
            <Block className="h-10 w-32 rounded-xl" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((card) => (
            <div key={card} className="rounded-2xl bg-muted/40 p-5">
              <Block className="h-4 w-20" />
              <Block className="mt-3 h-7 w-28" />
              <Block className="mt-3 h-3 w-full bg-muted/70" />
              <Block className="mt-1.5 h-3 w-4/5 bg-muted/70" />
              <Block className="mt-5 h-9 w-full rounded-xl" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DetailBody({ variant }: { variant: PageSkeletonVariant }): ReactElement {
  switch (variant) {
    case 'account':
      return <AccountSkeleton />;
    case 'agent':
      return <AgentSkeleton />;
    case 'agent-run':
      return <AgentRunSkeleton />;
    case 'auth':
      return <AuthSkeleton />;
    case 'dashboard':
      return <DashboardSkeleton />;
    case 'developer':
      return <DeveloperSkeleton />;
    case 'detail':
      return <DetailSkeleton />;
    case 'list':
      return <ListSkeleton />;
    case 'nav':
      return <NavSkeleton />;
    case 'notifications':
      return <NotificationsSkeleton />;
    case 'plugins':
      return <PluginsSkeleton />;
    case 'public':
      return <PublicSkeleton />;
    case 'rbac':
      return <RbacSkeleton />;
    case 'seo':
      return <SeoSkeleton />;
    case 'settings':
      return <SettingsSkeleton />;
    case 'themes':
      return <ThemesSkeleton />;
    case 'updates':
      return <UpdatesSkeleton />;
    case 'user-detail':
      return <UserDetailSkeleton />;
  }
}

export function PageSkeleton({ variant }: { variant: PageSkeletonVariant }): ReactElement {
  return (
    <div aria-busy="true" aria-live="polite" className="w-full">
      <DetailBody variant={variant} />
    </div>
  );
}
