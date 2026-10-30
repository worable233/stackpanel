import { cn } from './cn.js';

export type BadgeVariant = 'secondary' | 'outline' | 'destructive';

const variants: Record<BadgeVariant, string> = {
  secondary: 'bg-muted text-muted-foreground',
  outline: 'border border-border/70 text-foreground',
  destructive: 'bg-destructive/10 text-destructive',
};

export function Badge({
  variant = 'secondary',
  className,
  children,
}: {
  variant?: BadgeVariant;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium whitespace-nowrap',
        variants[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
