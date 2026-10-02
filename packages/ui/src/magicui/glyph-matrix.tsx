'use client';

import { useEffect, useRef, type HTMLAttributes } from 'react';

import { cn } from '../cn.js';

interface GlyphMatrixProps extends HTMLAttributes<HTMLCanvasElement> {
  /** Characters to randomly pick from */
  glyphs?: string;
  /** Cell size in px (also font size) */
  cellSize?: number;
  /** Probability (0-1) a cell mutates each tick */
  mutationRate?: number;
  /** Tick interval in ms */
  interval?: number;
  /** Fade out toward bottom (0 = no fade) */
  fadeBottom?: number;
  /** Glyph color (any CSS color). Pass a theme-aware value from the consumer. */
  color?: string;
}

/** Official Magic UI `glyph-matrix` component (vendored). An animated grid of
 * subtly shifting glyphs with a fade effect. */
export function GlyphMatrix({
  glyphs = '01·•+*/\\<>=',
  cellSize = 14,
  mutationRate = 0.04,
  interval = 90,
  className,
  fadeBottom = 0.6,
  color = '#6B7280',
  style,
  ...props
}: GlyphMatrixProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rgbaRef = useRef({ r: 107, g: 114, b: 128, a: 1 });

  useEffect(() => {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const probeCtx = probe.getContext('2d');
    if (!probeCtx) return;
    probeCtx.fillStyle = '#6B7280';
    probeCtx.fillStyle = color;
    probeCtx.fillRect(0, 0, 1, 1);
    const data = probeCtx.getImageData(0, 0, 1, 1).data;
    rgbaRef.current = {
      r: data[0] ?? 107,
      g: data[1] ?? 114,
      b: data[2] ?? 128,
      a: (data[3] ?? 255) / 255,
    };
  }, [color]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let cols = 0;
    let rows = 0;
    let cells: string[] = [];
    let alphas: number[] = [];
    let raf = 0;
    let last = 0;
    let stopped = false;

    const randomGlyph = () => glyphs[Math.floor(Math.random() * glyphs.length)] ?? '0';

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const { clientWidth: w, clientHeight: h } = canvas;

      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      cols = Math.ceil(w / cellSize);
      rows = Math.ceil(h / cellSize);

      cells = new Array(cols * rows).fill(0).map(() => randomGlyph());
      alphas = new Array(cols * rows).fill(0).map(() => 0.05 + Math.random() * 0.35);
    };

    const draw = () => {
      const { clientWidth: w, clientHeight: h } = canvas;
      ctx.clearRect(0, 0, w, h);

      ctx.font = `${cellSize - 2}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textBaseline = 'top';

      const { r, g, b, a: colorAlpha } = rgbaRef.current;
      for (let y = 0; y < rows; y++) {
        const fade = fadeBottom > 0 ? 1 - (y / rows) * fadeBottom : 1;
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          const a = (alphas[i] ?? 0) * fade * colorAlpha;
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
          ctx.fillText(cells[i] ?? '', x * cellSize, y * cellSize);
        }
      }
    };

    const tick = (t: number) => {
      if (stopped) return;

      if (t - last >= interval) {
        last = t;

        const total = cols * rows;
        const mutations = Math.max(1, Math.floor(total * mutationRate));

        for (let n = 0; n < mutations; n++) {
          const i = Math.floor(Math.random() * total);
          cells[i] = randomGlyph();
          alphas[i] = 0.05 + Math.random() * 0.45;
        }

        draw();
      }

      raf = requestAnimationFrame(tick);
    };

    resize();
    draw();
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(canvas);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [glyphs, cellSize, mutationRate, interval, fadeBottom]);

  return (
    <canvas
      ref={canvasRef}
      className={cn('pointer-events-none', className)}
      style={{ width: '100%', height: '100%', display: 'block', ...style }}
      aria-hidden="true"
      {...props}
    />
  );
}
