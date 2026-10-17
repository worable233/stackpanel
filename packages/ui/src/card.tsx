/**
 * Card Component - Clarity Design System
 *
 * 简洁的卡片组件，带统一的 hover 效果
 */

import * as React from 'react';
import { cn } from './cn.js';

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    /** 是否启用 hover 效果 */
    interactive?: boolean;
  }
>(({ className, interactive = false, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card"
    data-interactive={interactive || undefined}
    className={cn(
      'flex flex-col gap-6 rounded-xl border border-border bg-card py-6 text-card-foreground shadow-sm',
      interactive &&
        'cursor-pointer transition duration-300 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5 motion-reduce:transition-none',
      !interactive && 'transition-shadow duration-200',
      className,
    )}
    {...props}
  />
));
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 [.border-b]:pb-6 has-[>[data-slot=card-action]]:grid-cols-[1fr_auto]',
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

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('px-6', className)} {...props} />,
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex items-center px-6 [.border-t]:pt-6', className)}
      {...props}
    />
  ),
);
CardFooter.displayName = 'CardFooter';

function CardAction({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent, CardAction };
