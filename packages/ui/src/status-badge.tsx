export type StatusTone = 'ok' | 'warn' | 'error' | 'neutral';

export interface StatusBadgeProps {
  tone: StatusTone;
  children: React.ReactNode;
}

const toneClasses: Record<StatusTone, string> = {
  ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  neutral: 'bg-muted text-muted-foreground',
};

/** Small status pill. Tailwind + shadcn theme tokens only. */
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
