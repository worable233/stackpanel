'use client';

import { useEffect, useState } from 'react';
import { Activity, Coins, Gauge, Timer } from 'lucide-react';

export interface GatewayPublicStatsModel {
  avgLatencyMs: number | null;
  calls: number;
  model: string;
  successRate: number;
  tokens: number;
}

export interface GatewayPublicStats {
  activeModels: number;
  avgLatencyMs: number | null;
  date: string;
  hourly: number[];
  hourlyLabels?: string[];
  models: GatewayPublicStatsModel[];
  successCalls: number;
  successRate: number;
  totalCalls: number;
  totalTokens: number;
  updatedAt: string;
}

export interface LiveGatewayStatsLabels {
  activeModels: string;
  avgLatency: string;
  calls: string;
  hourly: string;
  live: string;
  noStats: string;
  ranking: string;
  rankingNote: string;
  refreshing: string;
  share: string;
  successRate: string;
  tokens: string;
  totalCalls: string;
  totalTokens: string;
  updated: string;
}

function compact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function timeLabel(value: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(value));
  } catch {
    return '—';
  }
}

export function LiveGatewayStats({
  initial,
  labels,
  locale = 'zh-CN',
}: {
  initial: GatewayPublicStats | null;
  labels: LiveGatewayStatsLabels;
  locale?: string;
}) {
  const [stats, setStats] = useState<GatewayPublicStats | null>(initial);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      setRefreshing(true);
      try {
        const response = await fetch('/api/public/gateway-stats', { cache: 'no-store' });
        if (!response.ok) return;
        const next = (await response.json()) as GatewayPublicStats;
        if (active && next && typeof next.totalCalls === 'number') setStats(next);
      } catch {
        // Keep the last known snapshot when the network blips.
      } finally {
        if (active) setRefreshing(false);
      }
    };
    const timer = window.setInterval(() => void refresh(), 15_000);
    void refresh();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const hourly = stats?.hourly?.length === 24 ? stats.hourly : Array(24).fill(0);
  const hourlyLabels = stats?.hourlyLabels ?? [];
  const hourlyMax = Math.max(...hourly, 1);
  const topModels = stats?.models.slice(0, 5) ?? [];
  const modelMax = Math.max(...topModels.map((item) => item.calls), 1);
  const updated = stats ? timeLabel(stats.updatedAt, locale) : '—';

  const metrics = [
    {
      icon: Activity,
      label: labels.totalCalls,
      value: stats ? compact(stats.totalCalls, locale) : '—',
      note: stats ? `${percent(stats.successRate)} ${labels.successRate}` : labels.noStats,
    },
    {
      icon: Coins,
      label: labels.totalTokens,
      value: stats ? compact(stats.totalTokens, locale) : '—',
      note: labels.live,
    },
    {
      icon: Gauge,
      label: labels.activeModels,
      value: stats ? String(stats.activeModels) : '—',
      note: labels.live,
    },
    {
      icon: Timer,
      label: labels.avgLatency,
      value: stats?.avgLatencyMs != null ? `${stats.avgLatencyMs} ms` : '—',
      note: labels.live,
    },
  ];

  return (
    <section className="flex flex-col gap-4" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          {labels.live}
        </span>
        <span className="text-xs text-muted-foreground">
          {labels.updated.replace('{time}', updated)}
          {refreshing ? ` · ${labels.refreshing}` : ''}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {metrics.map(({ icon: Icon, label, value, note }) => (
          <div key={label} className="rounded-[20px] bg-muted/40 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">{label}</span>
              <span className="flex size-8 items-center justify-center rounded-xl bg-background text-foreground">
                <Icon className="size-4" aria-hidden="true" />
              </span>
            </div>
            <p className="mt-4 text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
              {value}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{note}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="rounded-[24px] bg-muted/35 p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">{labels.hourly}</h3>
            <span className="text-xs text-muted-foreground">{labels.live}</span>
          </div>
          <div className="mt-6 flex h-48 items-end gap-1.5">
            {hourly.map((value, index) => (
              <div key={index} className="group flex h-full flex-1 flex-col justify-end gap-2">
                <div
                  className="w-full rounded-t bg-foreground/80 transition-all group-hover:bg-foreground"
                  style={{ height: `${Math.max(4, (value / hourlyMax) * 100)}%` }}
                  title={`${hourlyLabels[index] ?? String(index).padStart(2, '0')}:00 · ${value}`}
                />
                <span className="text-center text-[10px] text-muted-foreground/70">
                  {index % 6 === 0 ? (hourlyLabels[index] ?? String(index).padStart(2, '0')) : ''}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[24px] bg-muted/35 p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">{labels.ranking}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{labels.rankingNote}</p>
            </div>
          </div>
          {topModels.length === 0 ? (
            <p className="mt-8 rounded-xl bg-background/60 px-4 py-8 text-center text-sm text-muted-foreground">
              {labels.noStats}
            </p>
          ) : (
            <ol className="mt-5 flex flex-col gap-3">
              {topModels.map((item, index) => (
                <li key={item.model} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="font-mono text-xs text-muted-foreground/60">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span className="truncate font-medium">{item.model}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {compact(item.calls, locale)} {labels.calls}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-background/80">
                    <div
                      className="h-full rounded-full bg-foreground/80"
                      style={{ width: `${Math.max(3, (item.calls / modelMax) * 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>
                      {compact(item.tokens, locale)} {labels.tokens}
                    </span>
                    <span>
                      {percent(item.successRate)} · {item.avgLatencyMs ?? '—'} ms
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
