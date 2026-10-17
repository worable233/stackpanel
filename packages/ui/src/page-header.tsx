export interface PageHeaderProps {
  /** Optional content rendered above the title (breadcrumb, back link, badges). */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** @deprecated Page titles are intentionally a single heading. */
  description?: React.ReactNode;
  /** Primary actions, rendered to the right of the title block. */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Standard page title block: a single title on the left, actions
 * aligned to the right. Keeps every backend page header consistent.
 *
 * Tailwind + shadcn theme tokens only (no bespoke CSS).
 */
export function PageHeader({ eyebrow, title, actions, className }: PageHeaderProps) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-3 ${
        className ? ` ${className}` : ''
      }`}
    >
      <div className="min-w-0">
        {eyebrow}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
