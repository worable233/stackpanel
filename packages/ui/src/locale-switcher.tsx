'use client';

import { cn } from './cn.js';
import { Select } from './select.js';
import { Globe } from 'lucide-react';

export interface LocaleSwitcherItem {
  value: string;
  /** Display name of the language, in its own language (endonym). */
  label: string;
}

export interface LocaleSwitcherProps {
  items: LocaleSwitcherItem[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the control, already localised by the caller. */
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Presentational language picker primitive: a globe icon + native select.
 *
 * Kept copy-free (the caller passes the already-localised `ariaLabel` and the
 * endonym labels) so web and future apps can share it. Tailwind + shadcn theme
 * tokens only, no bespoke CSS.
 */
export function LocaleSwitcher({
  items,
  value,
  onChange,
  ariaLabel,
  disabled,
  className,
}: LocaleSwitcherProps) {
  return (
    <div className={cn('relative inline-flex items-center', className)}>
      <Globe
        className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground"
        aria-hidden="true"
      />
      <Select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-auto min-w-0 pl-8 pr-2 text-sm"
      >
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
