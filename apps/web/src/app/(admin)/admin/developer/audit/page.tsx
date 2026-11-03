import Link from 'next/link';
import type { AuditLogEntry, AuditLogResponse } from '@stackpanel/sdk';
import { List, ListEmpty, ListItem, PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getLocale } from '@/i18n/locale';
import { createTranslator, formatDate } from '@/i18n/core';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface CallMeta {
  method?: unknown;
  path?: unknown;
  status?: unknown;
  keyId?: unknown;
  resellerName?: unknown;
}

function metaOf(entry: AuditLogEntry): CallMeta {
  return entry.meta && typeof entry.meta === 'object' ? (entry.meta as CallMeta) : {};
}

function asText(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function AdminDeveloperAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const locale = await getLocale();
  const t = createTranslator(locale);
  const page = Math.max(1, Number(firstValue(params.page)) || 1);
  const resellerId = firstValue(params.resellerId).trim();

  let data: AuditLogResponse | null = null;
  let error: string | null = null;
  try {
    data = await (
      await getAuthedApiClient()
    ).listDeveloperCalls(page, PAGE_SIZE, {
      ...(resellerId ? { resellerId } : {}),
    });
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const hrefFor = (nextPage: number) => {
    const query = new URLSearchParams();
    if (resellerId) query.set('resellerId', resellerId);
    if (nextPage > 1) query.set('page', String(nextPage));
    const suffix = query.toString();
    return suffix ? `/admin/developer/audit?${suffix}` : '/admin/developer/audit';
  };

  return (
    <main className="flex w-full flex-col gap-6">
      <PageHeader title={t('admin.developer.calls.title')} />

      <form className="flex flex-wrap items-end gap-3" method="get">
        <div className="flex flex-col gap-1">
          <Label htmlFor="resellerId">{t('admin.developer.calls.filterReseller')}</Label>
          <Input
            id="resellerId"
            name="resellerId"
            defaultValue={resellerId}
            placeholder="cuid"
            className="w-64"
          />
        </div>
        <Button type="submit" variant="outline" size="sm">
          {t('admin.developer.calls.search')}
        </Button>
        <Button render={<Link href="/admin/developer/audit" />} variant="ghost" size="sm">
          {t('admin.developer.calls.reset')}
        </Button>
      </form>

      {error ? (
        <p className="text-sm text-destructive">{t('admin.developer.serviceUnavailable')}</p>
      ) : null}

      {data ? (
        <div className="flex flex-col gap-3">
          <List>
            {data.logs.length === 0 ? (
              <ListEmpty>{t('admin.developer.empty')}</ListEmpty>
            ) : (
              data.logs.map((entry) => {
                const meta = metaOf(entry);
                const reseller = asText(meta.resellerName) ?? asText(meta.keyId);
                return (
                  <ListItem key={entry.id} className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="font-mono text-xs font-medium">
                        {asText(meta.method) ?? '—'} {asText(meta.path) ?? '—'}
                      </span>
                      <span className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDate(new Date(entry.createdAt), locale, {
                          dateStyle: 'medium',
                          timeStyle: 'medium',
                        })}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>{reseller ?? t('admin.developer.calls.anonymous')}</span>
                      <span>{asText(meta.status) ?? '—'}</span>
                      <span className="font-mono">{entry.ip ?? '—'}</span>
                    </div>
                  </ListItem>
                );
              })
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
