'use client';

import { useEffect, useState, type CSSProperties } from 'react';

import { cn } from '../cn.js';

export interface MeteorsProps {
  number?: number;
  minDelay?: number;
  maxDelay?: number;
  minDuration?: number;
  maxDuration?: number;
  angle?: number;
  className?: string;
}

/** Official Magic UI `meteors` component (vendored), with the meteor head and
 * tail tinted to the theme accent (`--primary`) instead of the default
 * `zinc-500`. */
export function Meteors({
  number = 20,
  minDelay = 0.2,
  maxDelay = 1.2,
  minDuration = 2,
  maxDuration = 10,
  angle = 215,
  className,
}: MeteorsProps) {
  const [meteorStyles, setMeteorStyles] = useState<Array<CSSProperties>>([]);

  useEffect(() => {
    const styles = [...new Array(number)].map(() => ({
      '--angle': -angle + 'deg',
      top: '-5%',
      left: `calc(0% + ${Math.floor(Math.random() * window.innerWidth)}px)`,
      animationDelay: Math.random() * (maxDelay - minDelay) + minDelay + 's',
      animationDuration:
        Math.floor(Math.random() * (maxDuration - minDuration) + minDuration) + 's',
    })) as CSSProperties[];
    setMeteorStyles(styles);
  }, [number, minDelay, maxDelay, minDuration, maxDuration, angle]);

  return (
    <>
      {[...meteorStyles].map((style, idx) => (
        // Meteor Head
        <span
          key={idx}
          style={{ ...style }}
          className={cn(
            'animate-meteor pointer-events-none absolute size-0.5 rotate-(--angle) rounded-full bg-primary shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_20%,transparent)]',
            className,
          )}
        >
          {/* Meteor Tail */}
          <div className="pointer-events-none absolute top-1/2 -z-10 h-px w-12.5 -translate-y-1/2 bg-linear-to-r from-primary to-transparent" />
        </span>
      ))}
    </>
  );
}
