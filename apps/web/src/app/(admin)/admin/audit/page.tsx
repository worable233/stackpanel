import Link from 'next/link';
import type { AuditLogResponse } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getLocale } from '@/i18n/locale';
import { createTranslator, formatDate, type Translator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

const ACTION_KEYS: Record<string, string> = {
  'auth.login': 'auditAction.auth_login',
  'auth.login.failed': 'auditAction.auth_login_failed',
  'auth.logout': 'auditAction.auth_logout',
  'auth.forbidden': 'auditAction.auth_forbidden',
  'auth.oauth.login': 'auditAction.auth_oauth_login',
  'auth.oauth.failed': 'auditAction.auth_oauth_failed',
  'auth.oauth.conflict': 'auditAction.auth_oauth_conflict',
  'user.create': 'auditAction.user_create',
  'user.update': 'auditAction.user_update',
  'user.reset-password': 'auditAction.user_reset-password',
  'plugin.install': 'auditAction.plugin_install',
  'plugin.upgrade': 'auditAction.plugin_upgrade',
  'plugin.activate': 'auditAction.plugin_activate',
  'plugin.deactivate': 'auditAction.plugin_deactivate',
  'plugin.uninstall': 'auditAction.plugin_uninstall',
  'plugin.settings.update': 'auditAction.plugin_settings_update',
  'theme.install': 'auditAction.theme_install',
  'theme.activate': 'auditAction.theme_activate',
  'theme.preview.set': 'auditAction.theme_preview_set',
  'theme.preview.clear': 'auditAction.theme_preview_clear',
  'theme.delete': 'auditAction.theme_delete',
  'theme.settings.update': 'auditAction.theme_settings_update',
  'setting.set': 'auditAction.setting_set',
  'secret.set': 'auditAction.secret_set',
  'signing.key.set': 'auditAction.signing_key_set',
  'signing.key.clear': 'auditAction.signing_key_clear',
  'platform.info.update': 'auditAction.platform_info_update',
  'frontend.permission.denied': 'auditAction.frontend_permission_denied',
  'frontend.finder.call': 'auditAction.frontend_finder_call',
  'frontend.admin.route.render': 'auditAction.frontend_admin_route_render',
  'frontend.account.route.render': 'auditAction.frontend_account_route_render',
  'frontend.action.execute': 'auditAction.frontend_action_execute',
  'bootstrap.create': 'auditAction.bootstrap_create',
};

const RESOURCE_KEYS: Record<string, string> = {
  user: 'auditResource.user',
  plugin: 'auditResource.plugin',
  theme: 'auditResource.theme',
  setting: 'auditResource.setting',
  secret: 'auditResource.secret',
  platform: 'auditResource.platform',
};

function actionLabel(action: string, t: Translator): string {
  const key = ACTION_KEYS[action];
  return key ? t(key) : action;
}

function resourceLabel(resource: string, t: Translator): string {
  const key = RESOURCE_KEYS[resource];
  return key ? t(key) : resource;
}

function formatActor(actorId: string | null, t: Translator): string {
  return actorId ? actorId.slice(0, 12) : t('admin.audit.systemActor');
}

function describeMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const values = Object.entries(meta as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .map(([key, value]) => `${key}: ${String(value)}`);
  return values.length > 0 ? values.join(' · ') : null;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const locale = await getLocale();
  const t = createTranslator(locale);
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = 50;
  const action = typeof params.action === 'string' ? params.action : '';
  const resource = typeof params.resource === 'string' ? params.resource : '';
  const actorId = typeof params.actorId === 'string' ? params.actorId : '';

  let result: AuditLogResponse | null = null;
  let error: string | null = null;
  try {
    result = await (
      await getAuthedApiClient()
    ).getAuditLog(page, pageSize, {
      action: action || undefined,
      resource: resource || undefined,
      actorId: actorId || undefined,
    });
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.total / pageSize)) : 1;
  const hasFilter = Boolean(action || resource || actorId);

  const filterHref = (nextPage: number) => {
    const search = new URLSearchParams();
    if (action) search.set('action', action);
    if (resource) search.set('resource', resource);
    if (actorId) search.set('actorId', actorId);
    if (nextPage > 1) search.set('page', String(nextPage));
    const qs = search.toString();
    return qs ? `/admin/audit?${qs}` : '/admin/audit';
  };

  return (
    <main className="w-full space-y-6">
      <PageHeader title={t('admin.audit.title')} description={t('admin.audit.description')} />

      <form method="get" action="/admin/audit" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="action">{t('admin.audit.filterAction')}</Label>
          <Input
            id="action"
            name="action"
            defaultValue={action}
            placeholder={t('admin.audit.filterActionPlaceholder')}
            className="w-52"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="resource">{t('admin.audit.filterResource')}</Label>
          <Input
            id="resource"
            name="resource"
            defaultValue={resource}
            placeholder={t('admin.audit.filterResourcePlaceholder')}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="actorId">{t('admin.audit.filterActor')}</Label>
          <Input
            id="actorId"
            name="actorId"
            defaultValue={actorId}
            placeholder={t('admin.audit.filterActorPlaceholder')}
            className="w-52"
          />
        </div>
        <Button type="submit" className="w-fit">
          {t('admin.audit.search')}
        </Button>
        {hasFilter ? (
          <Button render={<Link href="/admin/audit" />} variant="outline" className="w-fit">
            {t('admin.audit.reset')}
          </Button>
        ) : null}
      </form>

      {error ? (
        <p className="text-sm text-destructive">
          {t('admin.audit.serviceUnavailable', { error })}
        </p>
      ) : null}
      {result ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('admin.audit.colTime')}</th>
                <th className="px-4 py-2 font-medium">{t('admin.audit.colAction')}</th>
                <th className="px-4 py-2 font-medium">{t('admin.audit.colResource')}</th>
                <th className="px-4 py-2 font-medium">{t('admin.audit.colActor')}</th>
                <th className="px-4 py-2 font-medium">{t('admin.audit.colSource')}</th>
              </tr>
            </thead>
            <tbody>
              {result.logs.map((log) => {
                const meta = describeMeta(log.meta);
                return (
                  <tr key={log.id} className="border-t align-top">
                    <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                      {formatDate(new Date(log.createdAt), locale, {
                        dateStyle: 'medium',
                        timeStyle: 'medium',
                      })}
                    </td>
                    <td className="px-4 py-2 font-medium">{actionLabel(log.action, t)}</td>
                    <td className="px-4 py-2">
                      {resourceLabel(log.resource, t)}
                      {log.resourceId ? ` / ${log.resourceId.slice(0, 12)}` : ''}
                      {meta ? <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p> : null}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{formatActor(log.actorId, t)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{log.ip ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {result.logs.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t('admin.audit.empty')}</p>
          ) : null}
        </div>
      ) : null}

      {result && result.total > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t('admin.audit.pagination', {
              total: result.total,
              page: result.page,
              pages: totalPages,
            })}
          </span>
          <div className="flex items-center gap-2">
            {page > 1 ? (
              <Button render={<Link href={filterHref(page - 1)} />} variant="outline" size="sm">
                {t('admin.audit.prev')}
              </Button>
            ) : (
              <span className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground/60">
                {t('admin.audit.prev')}
              </span>
            )}
            {page < totalPages ? (
              <Button render={<Link href={filterHref(page + 1)} />} variant="outline" size="sm">
                {t('admin.audit.next')}
              </Button>
            ) : (
              <span className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs text-muted-foreground/60">
                {t('admin.audit.next')}
              </span>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}
