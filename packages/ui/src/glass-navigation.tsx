'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from './cn.js';

/** One glass surface for the desktop bar and animated mobile expansion. */
export function GlassNavigation({
  brand,
  actions,
  links,
}: {
  brand: ReactNode;
  actions: ReactNode;
  links: Array<{ label: string; href: string; content?: ReactNode }>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const wide = window.matchMedia('(min-width: 1024px)');
    const resize = () => {
      if (wide.matches) setOpen(false);
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    wide.addEventListener('change', resize);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
      wide.removeEventListener('change', resize);
    };
  }, [open]);
  return (
    <header
      ref={root}
      onClickCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('a')) setOpen(false);
      }}
      className="fixed inset-x-0 top-0 z-50 px-4 pt-4 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-5 motion-safe:duration-700 md:px-12 lg:px-4"
    >
      <nav
        aria-label="主导航"
        className="mx-auto max-h-[calc(100dvh-2rem)] max-w-5xl overflow-auto rounded-md border border-foreground/10 bg-background/80 backdrop-blur-md md:max-h-[calc(60dvh-2rem)] lg:rounded-xl"
      >
        <div className="flex min-h-[52px] items-center justify-between gap-2 px-2.5 lg:min-h-12">
          {brand}
          <div className="hidden items-center lg:flex">
            {links.map((link) => (
              <span
                key={link.href}
                className="inline-flex h-9 items-center rounded-full text-sm font-medium transition-colors hover:bg-primary/20 focus-within:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring"
              >
                {link.content ?? (
                  <a
                    href={link.href}
                    className="flex size-full items-center rounded-[inherit] px-4 py-2 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {link.label}
                  </a>
                )}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {actions}
            <button
              ref={trigger}
              type="button"
              aria-label={open ? '关闭导航' : '打开导航'}
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen((value) => !value)}
              className="relative flex size-9 flex-col items-center justify-center gap-[6px] rounded-lg hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring lg:hidden"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'h-px w-[19px] rounded-full bg-foreground transition-transform duration-300 motion-reduce:transition-none',
                  open && 'translate-y-[3.5px] rotate-45',
                )}
              />
              <span
                aria-hidden="true"
                className={cn(
                  'h-px w-[19px] rounded-full bg-foreground transition-transform duration-300 motion-reduce:transition-none',
                  open && '-translate-y-[3.5px] -rotate-45',
                )}
              />
            </button>
          </div>
        </div>
        <div
          id={id}
          inert={!open}
          aria-hidden={!open}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-500 ease-out motion-reduce:transition-none lg:hidden',
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="overflow-hidden">
            <div className="flex flex-col gap-2.5 px-4 pb-4 pt-4">
              {links.map((link, index) => (
                <span
                  key={link.href}
                  className={cn(
                    'block rounded-md text-base font-medium transition-[opacity,translate,filter,background-color] duration-500 hover:bg-primary/20 focus:bg-primary/20 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none motion-reduce:blur-none',
                    open
                      ? 'translate-y-0 opacity-100 blur-0'
                      : 'translate-y-4 opacity-0 blur-[10px]',
                    open &&
                      ['delay-75', 'delay-150', 'delay-[225ms]', 'delay-300'][Math.min(index, 3)],
                  )}
                >
                  {link.content ?? (
                    <a
                      href={link.href}
                      className="flex size-full items-center rounded-[inherit] px-4 py-2 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {link.label}
                    </a>
                  )}
                </span>
              ))}
            </div>
          </div>
        </div>
      </nav>
    </header>
  );
}
