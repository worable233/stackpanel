import { List, ListEmpty, ListItem, SectionTitle, StatusBadge } from '@stackpanel/ui';
import Link from 'next/link';
import type { DeveloperOverviewResponse, ResellerListResponse } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getLocale } from '@/i18n/locale';
import { createTranslator, formatDate } from '@/i18n/core';
import { CreateResellerDialog, ResellerRowActions } from './reseller-manager';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export default async function AdminDeveloperPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const locale = await getLocale();
  const t = createTranslator(locale);
  const page = Math.max(1, Number(params.page) || 1);

  let overview: DeveloperOverviewResponse | null = null;
  let resellers: ResellerListResponse | null = null;
  let error: string | null = null;
  try {
    const client = await getAuthedApiClient();
    [overview, resellers] = await Promise.all([
      client.getDeveloperOverview(),
      client.listResellers(page, PAGE_SIZE),
    ]);
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  const totalPages = resellers ? Math.max(1, Math.ceil(resellers.total / PAGE_SIZE)) : 1;
  const hrefFor = (nextPage: number) =>
    nextPage > 1 ? `/admin/developer?page=${nextPage}` : '/admin/developer';

  return (
    <main className="flex w-full flex-col gap-6">
      <PageHeader title={t('admin.developer.title')} actions={<CreateResellerDialog />} />

      {error ? (
        <p className="text-sm text-destructive">{t('admin.developer.serviceUnavailable')}</p>
      ) : null}

      {overview ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader>
              <CardDescription>{t('admin.developer.overview.resellers')}</CardDescription>
              <CardTitle className="text-2xl">{overview.overview.resellers.total}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {t('admin.developer.overview.resellersHint', {
                  total: overview.overview.resellers.total,
                  active: overview.overview.resellers.active,
                })}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>{t('admin.developer.overview.pendingDeliveries')}</CardDescription>
              <CardTitle className="text-2xl">
                {overview.overview.webhookDeliveries.pending}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {t('admin.developer.overview.pendingDeliveriesHint')}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>{t('admin.developer.overview.failedDeliveries')}</CardDescription>
              <CardTitle className="text-2xl">
                {overview.overview.webhookDeliveries.failed}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {t('admin.developer.overview.failedDeliveriesHint')}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>{t('admin.developer.overview.calls24h')}</CardDescription>
              <CardTitle className="text-2xl">{overview.overview.calls.last24h}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {t('admin.developer.overview.calls24hHint', {
                  total: overview.overview.calls.total,
                })}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <SectionTitle as="h3">{t('admin.developer.overview.webhooks')}</SectionTitle>
            <CardDescription>{t('admin.developer.overview.webhooksDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button render={<Link href="/admin/developer/webhooks" />} variant="outline" size="sm">
              {t('admin.developer.overview.open')}
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <SectionTitle as="h3">{t('admin.developer.overview.calls')}</SectionTitle>
            <CardDescription>{t('admin.developer.overview.callsDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button render={<Link href="/admin/developer/audit" />} variant="outline" size="sm">
              {t('admin.developer.overview.open')}
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>{t('admin.developer.overview.channels')}</SectionTitle>
        {resellers ? (
          <List>
            {resellers.resellers.length === 0 ? (
              <ListEmpty>{t('admin.developer.empty')}</ListEmpty>
            ) : (
              resellers.resellers.map((reseller) => (
                <ListItem key={reseller.id} className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="font-medium">{reseller.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {reseller.keyId}
                      </span>
                    </div>
                    <StatusBadge tone={reseller.status === 'ACTIVE' ? 'ok' : 'neutral'}>
                      {reseller.status === 'ACTIVE'
                        ? t('admin.developer.resellers.statusActive')
                        : t('admin.developer.resellers.statusDisabled')}
                    </StatusBadge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{reseller.scopes.length > 0 ? reseller.scopes.join(' · ') : '—'}</span>
                    <span>
                      {t('admin.developer.resellers.colRateLimit')} {reseller.rateLimitRpm}
                    </span>
                    <span>
                      {reseller.lastUsedAt
                        ? formatDate(new Date(reseller.lastUsedAt), locale, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : t('admin.developer.resellers.never')}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      render={<Link href={`/admin/developer/resellers/${reseller.id}`} />}
                      variant="ghost"
                      size="sm"
                    >
                      {t('admin.developer.resellers.view')}
                    </Button>
                    <ResellerRowActions reseller={reseller} />
                  </div>
                </ListItem>
              ))
            )}
          </List>
        ) : null}

        {resellers && resellers.total > 0 ? (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {t('admin.developer.pagination', {
                total: resellers.total,
                page: resellers.page,
                pages: totalPages,
              })}
            </span>
            <div className="flex items-center gap-2">
              {page > 1 ? (
                <Button render={<Link href={hrefFor(page - 1)} />} variant="outline" size="sm">
                  {t('admin.developer.prev')}
                </Button>
              ) : (
                <span className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground/60">
                  {t('admin.developer.prev')}
                </span>
              )}
              {page < totalPages ? (
                <Button render={<Link href={hrefFor(page + 1)} />} variant="outline" size="sm">
                  {t('admin.developer.next')}
                </Button>
              ) : (
                <span className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground/60">
                  {t('admin.developer.next')}
                </span>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
