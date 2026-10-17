import { Check } from 'lucide-react';
import { cn } from './cn.js';

export interface StepperProps {
  steps: readonly string[];
  currentStep: number;
  /** Accessible name of the progress list; supplied by the caller (ADR-0016 §6). */
  label: string;
  className?: string;
}

/** Read-only progress indicator; future steps are not navigation controls. */
export function Stepper({ steps, currentStep, label, className }: StepperProps) {
  return (
    <ol aria-label={label} className={cn('flex items-start', className)}>
      {steps.map((step, index) => (
        <li
          key={step}
          aria-current={index === currentStep ? 'step' : undefined}
          className="relative flex min-w-0 flex-1 flex-col items-center gap-2.5"
        >
          {index > 0 && (
            <span
              aria-hidden="true"
              className={cn(
                'absolute right-[calc(50%+1.25rem)] top-4 h-px w-[calc(100%-2.5rem)]',
                index <= currentStep ? 'bg-primary/40' : 'bg-foreground/10',
              )}
            />
          )}
          <span
            aria-hidden="true"
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums',
              index === currentStep &&
                'border-primary/50 bg-primary/15 text-primary ring-4 ring-primary/5',
              index < currentStep && 'border-primary bg-primary text-primary-foreground',
              index > currentStep &&
                'border-foreground/10 bg-foreground/[0.025] text-muted-foreground',
            )}
          >
            {index < currentStep ? <Check className="size-3.5" /> : index + 1}
          </span>
          <span
            className={cn(
              'whitespace-nowrap text-xs leading-5',
              index === currentStep ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            {step}
          </span>
        </li>
      ))}
    </ol>
  );
}
