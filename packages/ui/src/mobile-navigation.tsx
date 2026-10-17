'use client';

import { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';

/** Accessible names for the mobile menu trigger; supplied by the caller. */
export interface MobileNavigationLabels {
  open: string;
  close: string;
}

export function MobileNavigation({
  links,
  labels,
}: {
  links: Array<{ label: string; href: string }>;
  /** Localized copy (ADR-0016 §6). */
  labels: MobileNavigationLabels;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="lg:hidden">
      <button
        ref={trigger}
        type="button"
        aria-label={open ? labels.close : labels.open}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex size-9 items-center justify-center rounded-lg hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </button>
      {open && (
        <div className="absolute inset-x-4 top-[78px] flex flex-col gap-1 rounded-xl border border-foreground/15 bg-background/90 p-3 shadow-2xl backdrop-blur-xl motion-safe:animate-nav-fade">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="rounded-lg px-4 py-3 text-sm hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring"
            >
              {link.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
