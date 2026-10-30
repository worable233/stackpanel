'use client';

import { useEffect, useId, useRef, useState, type MouseEvent, type ReactElement } from 'react';

export interface UsageTrendDetail {
  label: string;
  value: string;
}

export interface UsageTrendPoint {
  label: string;
  value: number;
  /** Extra rows rendered in the hover tooltip (input/output tokens, cache hit rate). */
  details?: UsageTrendDetail[];
}

export type UsageTrendFormat = 'currency' | 'compact';

const PLOT_LEFT = 72;
const PLOT_RIGHT = 16;
const PLOT_TOP = 18;
const PLOT_BOTTOM = 40;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value * 100) / 100);
}

function formatValue(value: number, format: UsageTrendFormat, currencySymbol: string): string {
  if (format === 'currency') return `${currencySymbol}${(value / 100).toFixed(2)}`;
  return formatCompact(value);
}

/**
 * Category trend chart for plugin account pages.
 *
 * Client component rendered through `@stackpanel/ui`; props stay serializable
 * (no formatter callbacks) so server-rendered plugin pages can pass them across
 * the client reference boundary. Wheel zoom is anchored under the pointer and
 * double-click resets the domain.
 */
export function UsageTrendChart({
  data,
  format,
  currencySymbol = '¥',
  ariaLabel,
}: {
  data: UsageTrendPoint[];
  format: UsageTrendFormat;
  currencySymbol?: string | undefined;
  ariaLabel: string;
}): ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null);
  const baseId = `usage-trend-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const gradientId = `${baseId}-fill`;
  const clipId = `${baseId}-clip`;
  const [size, setSize] = useState({ width: 800, height: 320 });
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const rows = data.map((point, index) => ({ ...point, index }));
  const fullEnd = Math.max(1, rows.length - 1);
  const [start, end] = zoom ?? [0, fullEnd];
  const span = Math.max(1, end - start);
  const maxValue = Math.max(0, ...rows.map((point) => point.value));
  const max = maxValue || 1;
  const plotWidth = Math.max(1, size.width - PLOT_LEFT - PLOT_RIGHT);
  const plotHeight = Math.max(1, size.height - PLOT_TOP - PLOT_BOTTOM);

  const xOf = (index: number) => PLOT_LEFT + ((index - start) / span) * plotWidth;
  const yOf = (value: number) => PLOT_TOP + plotHeight - (value / max) * plotHeight;

  const visible = rows.filter((point) => point.index >= start - 1 && point.index <= end + 1);
  const points = visible.map((point) => ({
    ...point,
    x: xOf(point.index),
    y: yOf(point.value),
  }));
  const line = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
  const area = points.length
    ? `${line} L ${points[points.length - 1]?.x ?? PLOT_LEFT} ${PLOT_TOP + plotHeight} L ${
        points[0]?.x ?? PLOT_LEFT
      } ${PLOT_TOP + plotHeight} Z`
    : '';

  const tickCount = clamp(Math.floor(plotWidth / 110), 2, 7);
  const xTicks = Array.from({ length: tickCount }, (_, index) => {
    const value = start + (span * index) / (tickCount - 1);
    return Math.round(clamp(value, 0, fullEnd));
  }).filter((value, index, values) => values.indexOf(value) === index);
  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const handleWheel = (event: WheelEvent) => {
      if (fullEnd <= 1) return;
      event.preventDefault();
      const [currentStart, currentEnd] = zoom ?? [0, fullEnd];
      const currentSpan = currentEnd - currentStart;
      const minSpan = Math.min(fullEnd, Math.max(1, fullEnd / 10));
      const nextSpan = clamp(currentSpan * (event.deltaY > 0 ? 1.2 : 0.82), minSpan, fullEnd);
      const rect = node.getBoundingClientRect();
      const ratio = clamp(
        (event.clientX - rect.left - PLOT_LEFT) / Math.max(1, rect.width - PLOT_LEFT - PLOT_RIGHT),
        0,
        1,
      );
      const anchor = currentStart + currentSpan * ratio;
      const nextStart = clamp(anchor - nextSpan * ratio, 0, fullEnd - nextSpan);
      setZoom([nextStart, nextStart + nextSpan]);
    };
    node.addEventListener('wheel', handleWheel, { passive: false });
    return () => node.removeEventListener('wheel', handleWheel);
  }, [fullEnd, zoom]);

  const handleMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const ratio = clamp((px - PLOT_LEFT) / Math.max(1, rect.width - PLOT_LEFT - PLOT_RIGHT), 0, 1);
    setHoverIndex(Math.round(clamp(start + ratio * span, 0, fullEnd)));
  };

  const hovered = hoverIndex === null ? null : rows[hoverIndex];
  const hoverX = hovered ? xOf(hovered.index) : 0;
  const hoverY = hovered ? yOf(hovered.value) : 0;
  const detailRows = hovered?.details ?? [];
  const tooltipWidth = 232;
  const tooltipHeight = 58 + detailRows.length * 18;
  const tooltipX = clamp(
    hoverX - tooltipWidth / 2,
    PLOT_LEFT,
    size.width - PLOT_RIGHT - tooltipWidth,
  );
  const maxTooltipY = Math.max(4, size.height - tooltipHeight - 4);
  let tooltipY = hoverY - tooltipHeight - 10;
  if (tooltipY < 4) tooltipY = Math.min(maxTooltipY, hoverY + 14);
  tooltipY = Math.max(4, tooltipY);

  return (
    <div
      ref={wrapRef}
      className="relative h-72 w-full cursor-crosshair touch-none select-none sm:h-80 [&_svg]:outline-none"
      onMouseMove={handleMove}
      onMouseLeave={() => setHoverIndex(null)}
      onDoubleClick={() => setZoom(null)}
    >
      <svg
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${size.width} ${size.height}`}
        className="block h-full w-full"
        role="img"
        aria-label={ariaLabel}
      >
        <title>{ariaLabel}</title>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.2} />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
          </linearGradient>
          <clipPath id={clipId}>
            <rect x={PLOT_LEFT} y={PLOT_TOP} width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>

        {yTicks.map((ratio) => {
          const y = PLOT_TOP + plotHeight * (1 - ratio);
          return (
            <g key={ratio}>
              <line
                x1={PLOT_LEFT}
                x2={size.width - PLOT_RIGHT}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeDasharray="3 4"
                opacity={0.7}
              />
              <text
                x={PLOT_LEFT - 10}
                y={y + 4}
                textAnchor="end"
                fontSize="12"
                fill="var(--muted-foreground)"
              >
                {formatValue(max * ratio, format, currencySymbol)}
              </text>
            </g>
          );
        })}

        {xTicks.map((index) => {
          const point = rows[index];
          if (!point) return null;
          return (
            <text
              key={`${index}-${point.label}`}
              x={xOf(index)}
              y={size.height - 14}
              textAnchor="middle"
              fontSize="12"
              fill="var(--muted-foreground)"
            >
              {point.label}
            </text>
          );
        })}

        <g clipPath={`url(#${clipId})`}>
          {area ? <path d={area} fill={`url(#${gradientId})`} /> : null}
          {line ? (
            <path
              d={line}
              fill="none"
              stroke="var(--primary)"
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}
        </g>

        {hovered ? (
          <g>
            <line
              x1={hoverX}
              x2={hoverX}
              y1={PLOT_TOP}
              y2={PLOT_TOP + plotHeight}
              stroke="var(--border)"
              strokeDasharray="3 4"
            />
            <circle
              cx={hoverX}
              cy={hoverY}
              r={4}
              fill="var(--primary)"
              stroke="var(--background)"
              strokeWidth={2}
            />
            <g transform={`translate(${tooltipX} ${tooltipY})`}>
              <rect
                width={tooltipWidth}
                height={tooltipHeight}
                rx={12}
                fill="var(--popover)"
                stroke="var(--border)"
              />
              <text x={12} y={18} fontSize="11" fill="var(--muted-foreground)">
                {hovered.label}
              </text>
              <text x={12} y={36} fontSize="14" fontWeight={600} fill="var(--popover-foreground)">
                {formatValue(hovered.value, format, currencySymbol)}
              </text>
              {detailRows.map((detail, index) => (
                <g key={`${detail.label}-${index}`} transform={`translate(0 ${56 + index * 18})`}>
                  <text x={12} y={0} fontSize="11" fill="var(--muted-foreground)">
                    {detail.label}
                  </text>
                  <text
                    x={tooltipWidth - 12}
                    y={0}
                    textAnchor="end"
                    fontSize="11"
                    fontWeight={500}
                    fill="var(--popover-foreground)"
                  >
                    {detail.value}
                  </text>
                </g>
              ))}
            </g>
          </g>
        ) : null}
      </svg>
    </div>
  );
}
