'use client';

import { type ReactNode } from 'react';
import { cn } from './cn.js';

/** Progressive enhancement: content remains visible without hydration or with reduced motion. */
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-reveal="visible" className={cn('translate-y-0 opacity-100 blur-0', className)}>
      {children}
    </div>
  );
}

/** Character reveal keeps the complete sentence available to assistive technology. */
export function RevealText({ text, className }: { text: string; className?: string }) {
  const delays = [
    'delay-0',
    'delay-[40ms]',
    'delay-[80ms]',
    'delay-[120ms]',
    'delay-[160ms]',
    'delay-[200ms]',
    'delay-[240ms]',
    'delay-[280ms]',
    'delay-[320ms]',
    'delay-[360ms]',
    'delay-[400ms]',
    'delay-[440ms]',
  ];
  return (
    <Reveal className="group/reveal inline">
      <span aria-label={text} className={className}>
        {Array.from(text).map((char, index) => (
          <span
            key={index}
            aria-hidden="true"
            data-reveal-character=""
            className={cn(
              'inline-block transition-[opacity,translate,filter] duration-700 group-data-[reveal=waiting]/reveal:translate-y-5 group-data-[reveal=waiting]/reveal:opacity-0 group-data-[reveal=waiting]/reveal:blur-[10px] motion-reduce:transition-none motion-reduce:opacity-100 motion-reduce:translate-y-0 motion-reduce:blur-none',
              delays[Math.min(index, delays.length - 1)],
            )}
          >
            {char === ' ' ? '\u00a0' : char}
          </span>
        ))}
      </span>
    </Reveal>
  );
}
