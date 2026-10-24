import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from './button.js';
import { cn } from './cn.js';

export interface PageHeaderProps {
  /** Optional content rendered above the title (breadcrumb or badges). Use backHref for returns. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** Parent route for detail/edit pages. Use a stable parent, not browser history. */
  backHref?: string;
  /** Localized accessible name for the icon-only back button. */
  backLabel?: string;
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
export function PageHeader({
  eyebrow,
  title,
  actions,
  backHref,
  backLabel,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-4', className)}>
      <div className="flex min-w-0 max-w-full items-center gap-3">
        {backHref ? (
          <Button
            variant="outline"
            size="icon"
            nativeButton={false}
            render={<Link href={backHref} />}
            aria-label={backLabel}
          >
            <ArrowLeft />
          </Button>
        ) : null}
        <div className="min-w-0">
          {eyebrow}
          <h1 className="text-2xl font-semibold tracking-tight break-words">{title}</h1>
        </div>
      </div>
      {actions ? (
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
