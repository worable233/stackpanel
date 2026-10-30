/**
 * Card Component - Clarity Design System
 *
 * 简洁的卡片组件：结构由组件定义，视觉完全由主题 token 控制。
 */

import * as React from 'react';
import { cn } from './cn.js';

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
    className={cn(
      'relative flex flex-col gap-3 rounded-xl border border-border bg-card py-4 text-card-foreground',
      interactive &&
        'cursor-pointer transition-colors hover:bg-muted/40 motion-reduce:transition-none',
      className,
    )}
    {...props}
  >
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
