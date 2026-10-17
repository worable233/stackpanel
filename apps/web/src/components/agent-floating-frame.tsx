'use client';

import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useTranslator } from '@/i18n/provider';

type Bounds = { x: number; y: number; width: number; height: number };
type Action = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const handles = [
  ['n', 'inset-x-3 -top-1 h-2 cursor-ns-resize'],
  ['s', 'inset-x-3 -bottom-1 h-2 cursor-ns-resize'],
  ['e', '-right-1 inset-y-3 w-2 cursor-ew-resize'],
  ['w', '-left-1 inset-y-3 w-2 cursor-ew-resize'],
  ['ne', '-right-1 -top-1 size-4 cursor-nesw-resize'],
  ['nw', '-left-1 -top-1 size-4 cursor-nwse-resize'],
  ['se', '-right-1 -bottom-1 size-4 cursor-nwse-resize'],
  ['sw', '-left-1 -bottom-1 size-4 cursor-nesw-resize'],
] as const;
function limits() {
  const header = document.querySelector('.backend-shell__header')?.getBoundingClientRect().bottom ?? 64;
  return { left: 12, top: Math.max(12, header + 12), right: innerWidth - 12, bottom: innerHeight - 12 };
}
function fit(b: Bounds): Bounds {
  const l = limits();
  const width = Math.min(b.width, l.right - l.left);
  const height = Math.min(b.height, Math.max(0, l.bottom - l.top));
  return { width, height, x: Math.max(l.left, Math.min(b.x, l.right - width)), y: Math.max(l.top, Math.min(b.y, l.bottom - height)) };
}

export function AgentFloatingFrame({ open, header, children }: { open: boolean; header: ReactNode; children: ReactNode }) {
  const t = useTranslator();
  const panel = useRef<HTMLElement>(null);
  const bounds = useRef<Bounds | null>(null);
  const animation = useRef<Animation | null>(null);
  const gesture = useRef<{ id: number; action: Action; x: number; y: number; bounds: Bounds } | null>(null);
  function position(next: Bounds) {
    bounds.current = next;
    const previous = animation.current;
    // Live geometry uses the browser animation API; appearance stays in Tailwind.
    animation.current = panel.current?.animate({ left: `${next.x}px`, top: `${next.y}px`, width: `${next.width}px`, height: `${next.height}px` }, { duration: 0, fill: 'forwards' }) ?? null;
    previous?.cancel();
  }
  useEffect(() => {
    if (!open) return;
    const update = () => {
      gesture.current = null;
      if (innerWidth < 640) { animation.current?.cancel(); return; }
      position(fit(bounds.current ?? { x: innerWidth - 472, y: limits().top, width: 460, height: 700 }));
    };
    update(); window.addEventListener('resize', update);
    return () => { window.removeEventListener('resize', update); animation.current?.cancel(); gesture.current = null; };
  }, [open]);
  function start(event: PointerEvent<HTMLElement>, action: Action) {
    if (innerWidth < 640 || event.button !== 0 || !bounds.current) return;
    if (action === 'move' && (event.target as HTMLElement).closest('button, a')) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { id: event.pointerId, action, x: event.clientX, y: event.clientY, bounds: { ...bounds.current } };
  }
  function move(event: PointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX - g.x, dy = event.clientY - g.y, b = g.bounds;
    if (g.action === 'move') { position(fit({ ...b, x: b.x + dx, y: b.y + dy })); return; }
    const l = limits(), minWidth = Math.min(340, l.right - l.left), minHeight = Math.min(420, l.bottom - l.top);
    let left = b.x, top = b.y, right = b.x + b.width, bottom = b.y + b.height;
    if (g.action.includes('w')) left = Math.max(l.left, Math.min(left + dx, right - minWidth));
    if (g.action.includes('e')) right = Math.min(l.right, Math.max(right + dx, left + minWidth));
    if (g.action.includes('n')) top = Math.max(l.top, Math.min(top + dy, bottom - minHeight));
    if (g.action.includes('s')) bottom = Math.min(l.bottom, Math.max(bottom + dy, top + minHeight));
    position({ x: left, y: top, width: right - left, height: bottom - top });
  }
  const end = () => { gesture.current = null; };
  if (!open) return null;
  return createPortal(
    <aside ref={panel} id="agent-workspace" aria-label={t('agentFrame.ariaLabel')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} className="fixed left-0 top-0 z-40 flex h-dvh w-full flex-col border border-border/70 bg-background shadow-2xl shadow-foreground/15 sm:left-auto sm:right-3 sm:top-20 sm:h-[700px] sm:w-[460px] sm:rounded-2xl">
      {handles.map(([edge, classes]) => <div key={edge} aria-hidden="true" onPointerDown={(event) => start(event, edge)} className={cn('absolute hidden touch-none sm:block', classes)} />)}
      <header title={t('agentFrame.dragHint')} onPointerDown={(event) => start(event, 'move')} className="flex h-13 shrink-0 items-center justify-between gap-3 px-4 sm:cursor-grab sm:touch-none sm:select-none sm:active:cursor-grabbing">{header}</header>
      {children}
    </aside>, document.body,
  );
}
