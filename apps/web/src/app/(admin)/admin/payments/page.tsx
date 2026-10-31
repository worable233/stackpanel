import Link from 'next/link';
import { InlineError, PageHeader } from '@stackpanel/ui';
import type { AdminPaymentListResponse } from '@stackpanel/sdk';
import { buttonVariants } from '@/components/ui/button';
import { PaymentRecords } from '@/components/payment-records';
import { getAuthedApiClient } from '@/lib/api';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;
const STATUSES = ['PENDING', 'PAID', 'REVIEW', 'CANCELLED', 'EXPIRED', 'REFUNDED'] as const;

const STATUS_LABEL_KEYS: Record<string, string> = {
  PENDING: 'adminPayments.statusPending',
  PAID: 'adminPayments.statusPaid',
  REVIEW: 'adminPayments.statusReview',
  CANCELLED: 'adminPayments.statusCancelled',
  EXPIRED: 'adminPayments.statusExpired',
  REFUNDED: 'adminPayments.statusRefunded',
};

function hrefFor(status: string | null, page: number): string {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/admin/payments?${qs}` : '/admin/payments';
}

/**
 * Payment records (operator view).
 *
 * A manual transfer has no callback: the operator has to match the incoming
 * money to a buyer and confirm it here. The page therefore stays a single
 * filterable list; the list itself is the working surface.
 */
export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const t = createTranslator(await getLocale());

  const status =
    typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status)
      ? sp.status
      : null;
  const page = Math.max(1, Number(sp.page) || 1);

  let data: AdminPaymentListResponse | null = null;
  let failed = false;
  try {
    const api = await getAuthedApiClient();
    data = await api.listAdminPayments({
      page,
      pageSize: PAGE_SIZE,
      ...(status ? { status } : {}),
    });
  } catch (error) {
    console.error('[admin/payments] load failed:', error);
    failed = true;
  }

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="flex w-full flex-col gap-4">
      <PageHeader title={t('adminPayments.title')} />

      <nav className="flex flex-wrap items-center gap-1" aria-label={t('adminPayments.filterStatus')}>
        <Link
          href={hrefFor(null, 1)}
          aria-current={status === null ? 'page' : undefined}
          className={cn(
            'inline-flex h-8 items-center rounded-md px-3 text-sm transition-colors',
            status === null
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          {t('adminPayments.filterAll')}
        </Link>
        {STATUSES.map((value) => (
          <Link
            key={value}
            href={hrefFor(value, 1)}
            aria-current={status === value ? 'page' : undefined}
            className={cn(
              'inline-flex h-8 items-center rounded-md px-3 text-sm transition-colors',
              status === value
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {t(STATUS_LABEL_KEYS[value] ?? 'adminPayments.statusUnknown')}
          </Link>
        ))}
      </nav>

      {failed ? (
        <InlineError className="rounded-xl px-4 py-10 text-center">
          {t('adminPayments.loadFailed')}
        </InlineError>
      ) : (
        <PaymentRecords payments={data?.payments ?? []} />
      )}

      {!failed && total > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {t('adminPayments.pageInfo', { page, pages, total })}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                className={buttonVariants({ size: 'sm', variant: 'secondary' })}
                href={hrefFor(status, page - 1)}
              >
                {t('adminPayments.prev')}
              </Link>
            ) : null}
            {page < pages ? (
              <Link
                className={buttonVariants({ size: 'sm', variant: 'secondary' })}
                href={hrefFor(status, page + 1)}
              >
                {t('adminPayments.next')}
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </main>
  );
}
