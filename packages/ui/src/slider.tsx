'use client';

import { Slider as SliderPrimitive } from '@animate-ui/react/primitives/base-ui/slider';
import { cn } from './cn.js';

export function Slider({
  className,
  defaultValue = [0],
  value,
  ...props
}: Omit<SliderPrimitive.Root.Props, 'className'> & { className?: string }) {
  const values = value ?? defaultValue;
  return (
    <SliderPrimitive.Root
      className={cn('w-full', className)}
      defaultValue={defaultValue}
      value={value}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex h-8 w-full touch-none items-center select-none data-disabled:opacity-50">
        <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-muted">
          <SliderPrimitive.Indicator className="h-full bg-primary" />
        </SliderPrimitive.Track>
        {Array.from({ length: Array.isArray(values) ? values.length : 1 }, (_, index) => (
          <SliderPrimitive.Thumb
            key={index}
            aria-label={props['aria-label']}
            className="block size-3 shrink-0 rounded-full border border-primary bg-background outline-none ring-ring/50 focus-visible:ring-3 data-disabled:cursor-not-allowed"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
