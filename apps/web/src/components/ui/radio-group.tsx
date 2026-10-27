'use client';

import { RadioGroup as RadioGroupPrimitive } from '@animate-ui/react/primitives/base-ui/radio-group';
import { Radio as RadioPrimitive } from '@animate-ui/react/primitives/base-ui/radio';
import { cn } from '@/lib/utils';

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return <RadioGroupPrimitive className={cn('flex flex-wrap gap-3', className)} {...props} />;
}

function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-primary outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-primary disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator className="flex items-center justify-center">
        <span className="size-2 rounded-full bg-primary" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
