import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const backendToolbarButtonClass =
  'size-9 shrink-0 rounded-full border-0 bg-transparent p-0 text-foreground shadow-none hover:bg-accent aria-expanded:bg-accent dark:hover:bg-accent has-[>svg]:px-0 [&_svg]:size-4';

export function BackendToolbarButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(backendToolbarButtonClass, className)}
      {...props}
    />
  );
}
