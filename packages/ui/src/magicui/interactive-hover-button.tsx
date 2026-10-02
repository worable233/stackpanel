'use client';

import React from 'react';

import { cn } from '../cn.js';

interface InteractiveHoverButtonProps extends React.HTMLAttributes<HTMLElement> {
  href?: string;
}

/** Official Magic UI `interactive-hover-button` component (vendored), adapted
 * to render an anchor when `href` is provided and to inline the arrow icon
 * instead of depending on lucide-react. */
export function InteractiveHoverButton({
  children,
  className,
  href,
  ...props
}: InteractiveHoverButtonProps) {
  const Comp: React.ElementType = href ? 'a' : 'button';
  return (
    <Comp
      href={href}
      className={cn(
        'group relative w-auto cursor-pointer overflow-hidden rounded-full border bg-background p-2 px-6 text-center font-semibold',
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-center gap-2">
        <div className="bg-primary h-2 w-2 rounded-full transition-all duration-300 group-hover:scale-[100.8]" />
        <span className="inline-block transition-all duration-300 group-hover:translate-x-12 group-hover:opacity-0">
          {children}
        </span>
      </div>
      <div
        className="absolute top-0 z-10 flex h-full w-full translate-x-12 items-center justify-center gap-2 text-primary-foreground opacity-0 transition-all duration-300 group-hover:-translate-x-5 group-hover:opacity-100"
        aria-hidden="true"
      >
        <span>{children}</span>
        <svg
          className="size-4 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </svg>
      </div>
    </Comp>
  );
}
