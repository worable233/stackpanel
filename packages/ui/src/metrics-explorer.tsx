'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClockIcon } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Select } from './select.js';

export interface MetricPointLike {
  t: number;
  v: number;
}

export interface MetricSeriesLike {
  id: string;
  label: string;
  unit: string;
  points: MetricPointLike[];
  color?: string | undefined;
}

export interface MetricsExplorerLabels {
  range: string;
  start: string;
  end: string;
  quick1h: string;
  quick6h: string;
  quick12h: string;
  quick24h: string;
  all: string;
  dataRange: string;
  empty: string;
  noData: string;
  points: string;
  latest: string;
  min: string;
  max: string;
  avg: string;
  custom: string;
}

const HOUR = 60 * 60 * 1000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toLocalInput(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(value);
}

function formatValue(value: number, unit: string, locale: string): string {
  const text = formatNumber(value, locale);
  return unit === '%' ? `${text}%` : `${text} ${unit}`;
}

function formatAxis(value: number, unit: string, locale: string): string {
  if (Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat(locale, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }
  return unit === '%' ? `${formatNumber(value, locale)}%` : formatNumber(value, locale);
}

function formatTime(value: number, locale: string, withDate = false): string {
  return new Intl.DateTimeFormat(locale, {
    ...(withDate ? { month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function formatFullTime(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function resolveText(value: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (text, [key, replacement]) => text.replaceAll(`{${key}}`, replacement),
    value,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function MetricCard({
  series,
  labels,
  locale,
}: {
  series: MetricSeriesLike;
  labels: MetricsExplorerLabels;
  locale: string;
}) {
  const points = series.points;
  const fullStart = points[0]!.t;
  const fullEnd = points[points.length - 1]!.t;
  const fullSpan = Math.max(fullEnd - fullStart, 1);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const values = points.map((point) => point.v);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const latest = points[points.length - 1]!;
  const domain = zoom ?? ([fullStart, fullEnd] as [number, number]);

  useEffect(() => {
    setZoom(null);
  }, [fullStart, fullEnd]);

  useEffect(() => {
    const node = chartRef.current;
    if (!node || points.length < 2) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      setZoom((current) => {
        const [start, end] = current ?? [fullStart, fullEnd];
        const span = Math.max(end - start, 1);
        const factor = event.deltaY > 0 ? 1.2 : 0.82;
        const minSpan = Math.min(fullSpan, Math.max(60_000, fullSpan / 200));
        const nextSpan = clamp(span * factor, minSpan, fullSpan);
        if (nextSpan >= fullSpan) return null;
        const anchor = start + ratio * span;
        let nextStart = anchor - ratio * nextSpan;
        let nextEnd = nextStart + nextSpan;
        if (nextStart < fullStart) {
          nextStart = fullStart;
          nextEnd = Math.min(fullEnd, nextStart + nextSpan);
        }
        if (nextEnd > fullEnd) {
          nextEnd = fullEnd;
          nextStart = Math.max(fullStart, nextEnd - nextSpan);
        }
        return [nextStart, nextEnd];
      });
    };
    node.addEventListener('wheel', handleWheel, { passive: false });
    return () => node.removeEventListener('wheel', handleWheel);
  }, [fullStart, fullEnd, fullSpan, points.length]);

  const gradientId = `metric-fill-${series.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  return (
    <figure className="flex min-w-0 flex-col gap-3 rounded-2xl bg-muted/25 p-4">
      <figcaption className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold">{series.label}</h4>
        </div>
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {formatValue(latest.v, series.unit, locale)}
        </p>
      </figcaption>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          [labels.latest, formatValue(latest.v, series.unit, locale)],
          [labels.min, formatValue(minValue, series.unit, locale)],
          [labels.max, formatValue(maxValue, series.unit, locale)],
          [labels.avg, formatValue(average, series.unit, locale)],
        ].map(([label, value]) => (
          <div
            key={label}
            className="flex min-w-0 flex-col gap-1 rounded-xl bg-background px-2.5 py-2"
          >
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className="truncate text-sm font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div
        ref={chartRef}
        className="h-52 w-full cursor-crosshair touch-none select-none sm:h-56 [&_svg]:outline-none"
        onDoubleClick={() => setZoom(null)}
        role="img"
        aria-label={`${series.label}, ${resolveText(labels.points, {
          count: String(points.length),
        })}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.16} />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.01} />
              </linearGradient>
            </defs>
            <CartesianGrid
              stroke="var(--border)"
              strokeOpacity={0.65}
              strokeDasharray="3 5"
              vertical={false}
            />
            <XAxis
              dataKey="t"
              type="number"
              domain={domain}
              allowDataOverflow
              tickFormatter={(value: number) => formatTime(value, locale, fullSpan > 24 * HOUR)}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickMargin={10}
              minTickGap={36}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={['auto', 'auto']}
              tickFormatter={(value: number) => formatAxis(value, series.unit, locale)}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickMargin={8}
              width={52}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{
                stroke: 'var(--muted-foreground)',
                strokeOpacity: 0.35,
                strokeDasharray: '3 3',
              }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const point = payload[0]?.payload as MetricPointLike | undefined;
                if (!point) return null;
                return (
                  <div className="rounded-xl bg-background px-3 py-2 shadow-sm">
                    <p className="text-xs text-muted-foreground">
                      {formatFullTime(point.t, locale)}
                    </p>
                    <p className="mt-0.5 text-sm font-semibold tabular-nums">
                      {formatValue(point.v, series.unit, locale)}
                    </p>
                  </div>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="v"
              stroke="var(--chart-1)"
              strokeWidth={2.25}
              fill={`url(#${gradientId})`}
              activeDot={{ r: 4, strokeWidth: 2, fill: 'var(--background)' }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/**
 * Interactive monitoring panel: quick ranges + exact start/end controls,
 * two-column per-series cards, wheel zoom, axes and a hover readout backed by
 * real sample points.
 */
export function MetricsExplorer({
  series,
  labels,
  locale = 'en-US',
}: {
  series: MetricSeriesLike[];
  labels: MetricsExplorerLabels;
  locale?: string | undefined;
}) {
  const available = useMemo(() => {
    const times = series.flatMap((item) => item.points.map((point) => point.t));
    return {
      min: times.length ? Math.min(...times) : 0,
      max: times.length ? Math.max(...times) : 0,
    };
  }, [series]);
  const hasData = available.max > 0;
  const [start, setStart] = useState(() =>
    hasData ? toLocalInput(Math.max(available.min, available.max - 6 * HOUR)) : '',
  );
  const [end, setEnd] = useState(() => (hasData ? toLocalInput(available.max) : ''));
  const [preset, setPreset] = useState<'1h' | '6h' | '12h' | '24h' | 'all' | 'custom'>('6h');
  const startMs = fromLocalInput(start);
  const endMs = fromLocalInput(end);
  const filtered = useMemo(() => {
    const from = Number.isFinite(startMs) ? startMs : available.min;
    const to = Number.isFinite(endMs) ? endMs : available.max;
    return series.map((item) => ({
      ...item,
      points: from <= to ? item.points.filter((point) => point.t >= from && point.t <= to) : [],
    }));
  }, [series, startMs, endMs, available.min, available.max]);
  const visible = filtered.filter((item) => item.points.length > 0);

  function choose(hours: number | null) {
    if (!hasData) return;
    const nextEnd = available.max;
    const nextStart =
      hours === null ? available.min : Math.max(available.min, nextEnd - hours * HOUR);
    setStart(toLocalInput(nextStart));
    setEnd(toLocalInput(nextEnd));
    setPreset(
      hours === null
        ? 'all'
        : hours === 1
          ? '1h'
          : hours === 6
            ? '6h'
            : hours === 12
              ? '12h'
              : '24h',
    );
  }

  if (!hasData) {
    return <p className="text-sm text-muted-foreground">{labels.empty}</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid gap-3 rounded-2xl bg-muted/25 p-4 sm:w-fit sm:grid-cols-[auto_10.5rem_minmax(0,1fr)_minmax(0,1fr)] sm:items-end">
        <div className="flex h-10 items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <CalendarClockIcon className="size-4" aria-hidden="true" />
          {labels.range}
        </div>
        <Select
          value={preset}
          aria-label={labels.range}
          className="h-10 w-full rounded-xl bg-background px-3 text-sm"
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'custom') {
              setPreset('custom');
              return;
            }
            choose(value === 'all' ? null : Number(value.slice(0, -1)));
          }}
        >
          {preset === 'custom' ? <option value="custom">{labels.custom}</option> : null}
          <option value="1h">{labels.quick1h}</option>
          <option value="6h">{labels.quick6h}</option>
          <option value="12h">{labels.quick12h}</option>
          <option value="24h">{labels.quick24h}</option>
          <option value="all">{labels.all}</option>
        </Select>
        <label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
          {labels.start}
          <input
            type="datetime-local"
            value={start}
            max={end}
            onChange={(event) => {
              setStart(event.target.value);
              setPreset('custom');
            }}
            className="h-10 w-full min-w-0 rounded-xl bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
          {labels.end}
          <input
            type="datetime-local"
            value={end}
            min={start}
            onChange={(event) => {
              setEnd(event.target.value);
              setPreset('custom');
            }}
            className="h-10 w-full min-w-0 rounded-xl bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <p className="text-xs text-muted-foreground sm:col-span-4">
          {resolveText(labels.dataRange, {
            start: formatFullTime(available.min, locale),
            end: formatFullTime(available.max, locale),
          })}
        </p>
      </div>
      {visible.length === 0 ? (
        <div className="rounded-2xl bg-muted/20 px-4 py-14 text-center text-sm text-muted-foreground">
          {labels.noData}
        </div>
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {visible.map((item) => (
            <MetricCard
              key={`${item.id}-${startMs}-${endMs}`}
              series={item}
              labels={labels}
              locale={locale}
            />
          ))}
        </div>
      )}
    </div>
  );
}
