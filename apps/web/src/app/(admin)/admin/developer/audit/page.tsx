import Link from 'next/link';
import type { AuditLogEntry, AuditLogResponse } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
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
    <main className="w-full space-y-6">
      <PageHeader
        title={t('admin.developer.calls.title')}
        description={t('admin.developer.calls.description')}
      />

      <form className="flex flex-wrap items-end gap-3" method="get">
        <div className="space-y-1">
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
        <p className="text-sm text-destructive">
          {t('admin.developer.serviceUnavailable', { error })}
        </p>
      ) : null}

      {data ? (
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[880px] text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('admin.developer.calls.colTime')}</th>
                  <th className="px-4 py-2 font-medium">{t('admin.developer.calls.colMethod')}</th>
                  <th className="px-4 py-2 font-medium">{t('admin.developer.calls.colPath')}</th>
                  <th className="px-4 py-2 font-medium">{t('admin.developer.calls.colReseller')}</th>
                  <th className="px-4 py-2 font-medium">{t('admin.developer.calls.colStatus')}</th>
                  <th className="px-4 py-2 font-medium">{t('admin.developer.calls.colIp')}</th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((entry) => {
                  const meta = metaOf(entry);
                  const reseller = asText(meta.resellerName) ?? asText(meta.keyId);
                  return (
                    <tr key={entry.id} className="border-t align-top">
                      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                        {formatDate(new Date(entry.createdAt), locale, {
                          dateStyle: 'medium',
                          timeStyle: 'medium',
                        })}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">{asText(meta.method) ?? '—'}</td>
                      <td className="max-w-md truncate px-4 py-2 font-mono text-xs">
                        {asText(meta.path) ?? '—'}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {reseller ?? t('admin.developer.calls.anonymous')}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {asText(meta.status) ?? '—'}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                        {entry.ip ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data.logs.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{t('admin.developer.empty')}</p>
            ) : null}
          </div>

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
