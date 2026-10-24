'use client';

import { type ReactNode } from 'react';

/** Radial border and subtle surface lighting track the pointer independently. */
export function Spotlight({ children }: { children: ReactNode }) {
  return (
    <div
      className="group relative isolate h-full rounded-xl border border-foreground/10"
      data-spotlight=""
    >
      <div
        aria-hidden="true"
        data-spotlight-layer="border"
        className="pointer-events-none absolute -inset-px z-10 rounded-[inherit] p-px opacity-0 [mask-image:linear-gradient(#000_0_0),linear-gradient(#000_0_0)] [mask-clip:content-box,border-box] [mask-composite:exclude]"
      />
      <div
        aria-hidden="true"
        data-spotlight-layer="surface"
        className="pointer-events-none absolute inset-0 z-0 rounded-[inherit] opacity-0"
      />
      <div className="relative z-1 h-full overflow-hidden rounded-[inherit]">{children}</div>
    </div>
  );
}
