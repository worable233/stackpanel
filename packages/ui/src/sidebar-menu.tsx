import { cloneElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { cn } from './cn.js';

export function SidebarMenu({ className, ...props }: ComponentProps<'ul'>) {
  return (
    <ul data-slot="sidebar-menu" className={cn('flex flex-col gap-1', className)} {...props} />
  );
}

/** Compose with the host router's link so navigation stays within the shared layout. */
export function SidebarMenuLink({
  render,
  active = false,
  children,
  className,
}: {
  render: ReactElement<{
    className?: string;
    children?: ReactNode;
    'aria-current'?: 'page' | undefined;
  }>;
  active?: boolean;
  children: ReactNode;
  className?: string | undefined;
}) {
  return cloneElement(render, {
    'aria-current': active ? 'page' : undefined,
    className: cn(
      'flex min-h-9 w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0',
      active
        ? 'bg-accent font-medium text-accent-foreground [&_svg]:text-primary'
        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      render.props.className,
      className,
    ),
    children,
  });
}
