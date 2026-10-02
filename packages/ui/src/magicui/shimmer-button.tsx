import React, { type CSSProperties } from 'react';

import { cn } from '../cn.js';

export interface ShimmerButtonProps extends React.HTMLAttributes<HTMLElement> {
  shimmerColor?: string;
  shimmerSize?: string;
  borderRadius?: string;
  shimmerDuration?: string;
  background?: string;
  href?: string;
}

/** Official Magic UI `shimmer-button` component (vendored), adapted to render
 * an anchor when `href` is provided and a button otherwise. */
export const ShimmerButton = React.forwardRef<HTMLElement, ShimmerButtonProps>(
  (
    {
      shimmerColor = '#ffffff',
      shimmerSize = '0.05em',
      shimmerDuration = '3s',
      borderRadius = '100px',
      background = 'rgba(0, 0, 0, 1)',
      href,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const Comp: React.ElementType = href ? 'a' : 'button';
    return (
      <Comp
        href={href}
        style={
          {
            '--spread': '90deg',
            '--shimmer-color': shimmerColor,
            '--radius': borderRadius,
            '--speed': shimmerDuration,
            '--cut': shimmerSize,
            '--bg': background,
          } as CSSProperties
        }
        className={cn(
          'group relative z-0 flex cursor-pointer items-center justify-center overflow-hidden [border-radius:var(--radius)] border border-white/10 px-6 py-3 whitespace-nowrap text-white [background:var(--bg)]',
          'transform-gpu transition-transform duration-300 ease-in-out active:translate-y-px',
          className,
        )}
        ref={ref as never}
        {...props}
      >
        {/* spark container */}
        <div
          className={cn('-z-30 blur-[2px]', '@container-[size] absolute inset-0 overflow-visible')}
        >
          {/* spark */}
          <div className="animate-shimmer-slide absolute inset-0 aspect-[1] h-[100cqh] rounded-none [mask:none]">
            {/* spark before */}
            <div className="animate-spin-around absolute -inset-full w-auto [translate:0_0] rotate-0 [background:conic-gradient(from_calc(270deg-(var(--spread)*0.5)),transparent_0,var(--shimmer-color)_var(--spread),transparent_var(--spread))]" />
          </div>
        </div>
        {children}

        {/* Highlight */}
        <div
          className={cn(
            'absolute inset-0 size-full',

            'rounded-2xl px-4 py-1.5 text-sm font-medium',

            // top sheen (white in light mode, dark depth shadow in dark mode)
            'shadow-[inset_0_-8px_10px_#ffffff1f] dark:shadow-[inset_0_-8px_10px_rgba(0,0,0,0.35)]',

            // transition
            'transform-gpu transition-all duration-300 ease-in-out',

            // on hover
            'group-hover:shadow-[inset_0_-6px_10px_#ffffff3f] group-hover:dark:shadow-[inset_0_-6px_10px_rgba(0,0,0,0.5)]',

            // on click
            'group-active:shadow-[inset_0_-10px_10px_#ffffff3f] group-active:dark:shadow-[inset_0_-10px_10px_rgba(0,0,0,0.5)]',
          )}
        />

        {/* backdrop */}
        <div
          className={cn(
            'absolute inset-(--cut) -z-20 [border-radius:var(--radius)] [background:var(--bg)]',
          )}
        />
      </Comp>
    );
  },
);

ShimmerButton.displayName = 'ShimmerButton';
