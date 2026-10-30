export type StatusTone = 'ok' | 'warn' | 'error' | 'neutral';

export interface StatusBadgeProps {
  tone: StatusTone;
  children: React.ReactNode;
}

const toneClasses: Record<StatusTone, string> = {
  ok: 'bg-success/10 text-success',
  warn: 'bg-warning/10 text-warning',
  error: 'bg-destructive/10 text-destructive',
  neutral: 'bg-muted text-muted-foreground',
};

/** Small status pill. Colors come from the active theme's semantic tokens. */
export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${toneClasses[tone]}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}
