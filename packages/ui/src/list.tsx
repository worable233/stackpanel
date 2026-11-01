import type { ComponentProps } from 'react';
import { cn } from './cn.js';

/**
 * Canonical list shell.
 *
 * Lists in the product are card rows on the page surface, never bordered
 * tables: the same row rhythm is used by store orders, payment records, admin
 * user details and plugin admin panels so switching pages does not change how
 * a record looks. Content inside a row is free-form; only the shell is fixed.
 */
export function List({ className, ...props }: ComponentProps<'ul'>) {
  return <ul data-slot="list" className={cn('flex flex-col gap-2.5', className)} {...props} />;
}

export function ListItem({ className, ...props }: ComponentProps<'li'>) {
  return (
    <li
      data-slot="list-item"
      className={cn('rounded-2xl bg-muted/40 p-4 text-card-foreground', className)}
      {...props}
    />
  );
}

export function ListEmpty({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="list-empty"
      className={cn(
        'rounded-2xl bg-muted/25 px-6 py-12 text-center text-sm text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
