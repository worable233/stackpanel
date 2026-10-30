'use client';

import { type ReactNode } from 'react';

/** Plain wrapper kept for API compatibility; no pointer-tracking decoration. */
export function Spotlight({ children }: { children: ReactNode }) {
  return <div className="h-full rounded-xl border border-border">{children}</div>;
}
