'use client';

import { type ComponentPropsWithoutRef, type CSSProperties } from 'react';

import { cn } from '../cn.js';

export interface AnimatedGradientTextProps extends ComponentPropsWithoutRef<'div'> {
  speed?: number;
  colorFrom?: string;
  colorTo?: string;
}

/** Official Magic UI `animated-gradient-text` component (vendored). Text whose
 * gradient background animates between two colors. */
export function AnimatedGradientText({
  children,
  className,
  speed = 1,
  colorFrom = '#ffaa40',
  colorTo = '#9c40ff',
  ...props
}: AnimatedGradientTextProps) {
  return (
    <span
      style={
        {
          '--bg-size': `${speed * 300}%`,
          '--color-from': colorFrom,
          '--color-to': colorTo,
        } as CSSProperties
      }
      className={cn(
        'animate-gradient inline bg-linear-to-r from-(--color-from) via-(--color-to) to-(--color-from) bg-size-[var(--bg-size)_100%] bg-clip-text text-transparent',
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
