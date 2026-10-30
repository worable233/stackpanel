'use client';

import { useState } from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';

import { Button } from './button.js';
import { cn } from './cn.js';
import { CopyButton } from './copy-button.js';

export interface SecretValueProps {
  value: string;
  mask?: string | undefined;
  emptyLabel?: string | undefined;
  revealLabel: string;
  hideLabel: string;
  copyLabel: string;
  copiedLabel: string;
  className?: string | undefined;
}

/**
 * Reveal/copy control for values that should not be visible at rest
 * (public IPs, root passwords). Defaults to hidden.
 */
export function SecretValue({
  value,
  mask = '••••••••',
  emptyLabel = '—',
  revealLabel,
  hideLabel,
  copyLabel,
  copiedLabel,
  className,
}: SecretValueProps) {
  const [revealed, setRevealed] = useState(false);
  const hasValue = value !== '' && value !== '—';
  if (!hasValue) return <span className="text-muted-foreground">{emptyLabel}</span>;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-0.5', className)}>
      <span className="min-w-0 break-all font-mono text-xs leading-5">
        {revealed ? value : mask}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={revealed ? hideLabel : revealLabel}
        title={revealed ? hideLabel : revealLabel}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </Button>
      <CopyButton value={value} label={copyLabel} copiedLabel={copiedLabel} />
    </span>
  );
}
