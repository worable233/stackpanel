import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Layers3 } from 'lucide-react';
import { cn } from './cn.js';

export interface SectionTitleProps extends ComponentPropsWithoutRef<'h2'> {
  icon?: ReactNode;
  as?: 'h2' | 'h3';
}

/** Consistent content-section heading, distinct from the page title. */
export function SectionTitle({ icon, as: Heading = 'h2', children, className, ...props }: SectionTitleProps) {
  return (
    <Heading data-slot="section-title" className={cn('flex items-center gap-2 text-base font-semibold leading-snug text-foreground', className)} {...props}>
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary [&_svg]:size-4">
        {icon ?? <Layers3 />}
      </span>
      <span className="min-w-0">{children}</span>
    </Heading>
  );
}
