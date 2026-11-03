import Link from 'next/link';
import type { WebhookDeliveryListResponse } from '@stackpanel/sdk';
import { List, ListEmpty, ListItem, PageHeader, Select } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getLocale } from '@/i18n/locale';
import { createTranslator, formatDate, type Translator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;
const STATUSES = ['PENDING', 'DELIVERING', 'SUCCEEDED', 'FAILED'] as const;

function statusLabel(status: string, t: Translator): string {
  switch (status) {
    case 'PENDING':
      return t('admin.developer.webhooks.statusPending');
    case 'DELIVERING':
      return t('admin.developer.webhooks.statusDelivering');
    case 'SUCCEEDED':
      return t('admin.developer.webhooks.statusSucceeded');
    case 'FAILED':
      return t('admin.developer.webhooks.statusFailed');
    default:
      return status;
  }
}

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function AdminDeveloperWebhooksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const locale = await getLocale();
  const t = createTranslator(locale);
  const page = Math.max(1, Number(firstValue(params.page)) || 1);
  const status = firstValue(params.status);
  const resellerId = firstValue(params.resellerId).trim();

  let data: WebhookDeliveryListResponse | null = null;
  let error: string | null = null;
  try {
    data = await (
      await getAuthedApiClient()
    ).listWebhookDeliveries(page, PAGE_SIZE, {
      ...(status ? { status } : {}),
      ...(resellerId ? { resellerId } : {}),
    });
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const hrefFor = (nextPage: number) => {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (resellerId) query.set('resellerId', resellerId);
    if (nextPage > 1) query.set('page', String(nextPage));
    const suffix = query.toString();
    return suffix ? `/admin/developer/webhooks?${suffix}` : '/admin/developer/webhooks';
  };

  return (
    <main className="flex w-full flex-col gap-6">
      <PageHeader title={t('admin.developer.webhooks.title')} />

      <form className="flex flex-wrap items-end gap-3" method="get">
        <div className="flex flex-col gap-1">
          <Label htmlFor="resellerId">{t('admin.developer.webhooks.filterReseller')}</Label>
          <Input
            id="resellerId"
            name="resellerId"
            defaultValue={resellerId}
            placeholder="cuid"
            className="w-64"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="status">{t('admin.developer.webhooks.filterStatus')}</Label>
          <Select id="status" name="status" defaultValue={status}>
            <option value="">{t('admin.developer.webhooks.filterAll')}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {statusLabel(value, t)}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline" size="sm">
          {t('admin.developer.webhooks.search')}
        </Button>
        <Button render={<Link href="/admin/developer/webhooks" />} variant="ghost" size="sm">
          {t('admin.developer.webhooks.reset')}
        </Button>
      </form>

      {error ? (
        <p className="text-sm text-destructive">{t('admin.developer.serviceUnavailable')}</p>
      ) : null}

      {data ? (
        <div className="flex flex-col gap-3">
          <List>
            {data.deliveries.length === 0 ? (
              <ListEmpty>{t('admin.developer.empty')}</ListEmpty>
            ) : (
              data.deliveries.map((delivery) => (
                <ListItem key={delivery.id} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="font-mono text-xs font-medium">{delivery.event}</span>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDate(new Date(delivery.createdAt), locale, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{delivery.resellerName ?? delivery.resellerId}</span>
                    <span>{statusLabel(delivery.status, t)}</span>
                    <span>
                      {delivery.attempts}/{delivery.maxAttempts}
                    </span>
                    <span>{delivery.responseCode ?? '—'}</span>
                    <span className="max-w-full truncate">{delivery.error ?? '—'}</span>
                  </div>
                </ListItem>
              ))
            )}
          </List>

          {data.total > 0 ? (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {t('admin.developer.pagination', {
                  total: data.total,
                  page: data.page,
                  pages: totalPages,
                })}
              </span>
              <div className="flex items-center gap-2">
                {page > 1 ? (
                  <Button render={<Link href={hrefFor(page - 1)} />} variant="outline" size="sm">
                    {t('admin.developer.prev')}
                  </Button>
                ) : null}
                {page < totalPages ? (
                  <Button render={<Link href={hrefFor(page + 1)} />} variant="outline" size="sm">
                    {t('admin.developer.next')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
