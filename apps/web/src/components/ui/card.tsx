/**
 * Card Component - Clarity Design System
 *
 * 简洁的卡片组件，带统一的 hover 效果
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    /** 是否启用 hover 效果 */
    interactive?: boolean;
  }
>(({ className, children, interactive = false, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card"
    data-spotlight=""
    data-interactive={interactive || undefined}
    className={cn(
      'relative isolate flex flex-col gap-3 rounded-xl border border-border bg-card py-4 text-card-foreground shadow-sm [&>*:not([data-spotlight-layer])]:relative [&>*:not([data-spotlight-layer])]:z-[1]',
      interactive &&
        'cursor-pointer transition duration-300 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5 motion-reduce:transition-none',
      !interactive && 'transition-shadow duration-200',
      className,
    )}
    {...props}
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
    {children}
  </div>
));
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-4 [.border-b]:pb-4 has-[>[data-slot=card-action]]:grid-cols-[1fr_auto]',
        className,
      )}
      {...props}
    />
  ),
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn('font-semibold leading-none', className)} {...props} />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
));
CardDescription.displayName = 'CardDescription';

/** Trailing action inside a `CardHeader` (top-right slot). */
const CardAction = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  ),
);
CardAction.displayName = 'CardAction';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('px-4', className)} {...props} />,
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex items-center px-4 [.border-t]:pt-4', className)}
      {...props}
    />
  ),
);
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent, CardAction };
