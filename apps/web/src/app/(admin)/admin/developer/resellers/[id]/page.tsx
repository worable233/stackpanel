import Link from 'next/link';
import type { ResellerDetailResponse, WebhookDeliveryView } from '@stackpanel/sdk';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getLocale } from '@/i18n/locale';
import type { Locale } from '@/i18n/config';
import { createTranslator, formatDate, type Translator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

function deliveryStatusLabel(status: string, t: Translator): string {
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

function DeliveryTable({
  deliveries,
  locale,
  t,
}: {
  deliveries: WebhookDeliveryView[];
  locale: Locale;
  t: Translator;
}) {
  if (deliveries.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t('admin.developer.detail.noDeliveries')}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">{t('admin.developer.webhooks.colTime')}</th>
            <th className="px-4 py-2 font-medium">{t('admin.developer.webhooks.colEvent')}</th>
            <th className="px-4 py-2 font-medium">{t('admin.developer.webhooks.colStatus')}</th>
            <th className="px-4 py-2 font-medium">{t('admin.developer.webhooks.colAttempts')}</th>
            <th className="px-4 py-2 font-medium">{t('admin.developer.webhooks.colCode')}</th>
            <th className="px-4 py-2 font-medium">{t('admin.developer.webhooks.colError')}</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((delivery) => (
            <tr key={delivery.id} className="border-t align-top">
              <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                {formatDate(new Date(delivery.createdAt), locale, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </td>
              <td className="px-4 py-2 font-mono text-xs">{delivery.event}</td>
              <td className="px-4 py-2">{deliveryStatusLabel(delivery.status, t)}</td>
              <td className="px-4 py-2 text-muted-foreground">
                {delivery.attempts}/{delivery.maxAttempts}
              </td>
              <td className="px-4 py-2 text-muted-foreground">{delivery.responseCode ?? '—'}</td>
              <td className="max-w-xs px-4 py-2 text-muted-foreground">{delivery.error ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function AdminDeveloperResellerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const locale = await getLocale();
  const t = createTranslator(locale);

  let data: ResellerDetailResponse | null = null;
  let error: string | null = null;
  try {
    data = await (await getAuthedApiClient()).getReseller(id);
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  const fields: Array<{ label: string; value: React.ReactNode }> = data
    ? [
        { label: t('admin.developer.detail.keyId'), value: <span className="font-mono text-xs">{data.reseller.keyId}</span> },
        {
          label: t('admin.developer.detail.hasWebhookKey'),
          value: data.reseller.hasWebhookKey
            ? t('admin.developer.detail.yes')
            : t('admin.developer.detail.no'),
        },
        { label: t('admin.developer.detail.webhookUrl'), value: data.reseller.webhookUrl ?? '—' },
        {
          label: t('admin.developer.detail.scopes'),
          value: data.reseller.scopes.length > 0 ? data.reseller.scopes.join(' · ') : '—',
        },
        { label: t('admin.developer.detail.rateLimit'), value: String(data.reseller.rateLimitRpm) },
        {
          label: t('admin.developer.detail.lastUsed'),
          value: data.reseller.lastUsedAt
            ? formatDate(new Date(data.reseller.lastUsedAt), locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })
            : t('admin.developer.resellers.never'),
        },
        { label: t('admin.developer.detail.lastUsedIp'), value: data.reseller.lastUsedIp ?? '—' },
        {
          label: t('admin.developer.detail.createdAt'),
          value: formatDate(new Date(data.reseller.createdAt), locale, { dateStyle: 'medium' }),
        },
        {
          label: t('admin.developer.detail.updatedAt'),
          value: formatDate(new Date(data.reseller.updatedAt), locale, { dateStyle: 'medium' }),
        },
      ]
    : [];

  return (
    <main className="w-full space-y-6">
      <PageHeader
        eyebrow={
          <Link
            href="/admin/developer"
            className="mb-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {t('admin.developer.detail.backToList')}
          </Link>
        }
        title={data ? data.reseller.name : t('admin.developer.resellers.title')}
        description={t('admin.developer.resellers.description')}
      />

      {error ? (
        <p className="text-sm text-destructive">
          {t('admin.developer.serviceUnavailable', { error })}
        </p>
      ) : null}

      {data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('admin.developer.detail.identity')}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                {fields.map((field) => (
                  <div key={field.label} className="space-y-1">
                    <dt className="text-xs text-muted-foreground">{field.label}</dt>
                    <dd className="text-sm">{field.value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              {t('admin.developer.detail.recentDeliveries')}
            </h2>
            <DeliveryTable deliveries={data.deliveries} locale={locale} t={t} />
          </div>
        </>
      ) : null}
    </main>
  );
}
