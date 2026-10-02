import Link from 'next/link';
import type { AdminPlugin, PluginDependencyStatus, PluginConsumesStatus } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { Button } from '@/components/ui/button';
import { getLocale } from '@/i18n/locale';
import { createTranslator, type Translator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

function DependencyBadge({
  dependency,
  t,
}: {
  dependency: PluginDependencyStatus;
  t: Translator;
}) {
  const range = dependency.range ? `@${dependency.range}` : '';
  if (dependency.satisfied) {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        {dependency.id}
        {range}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
      {dependency.id}
      {range}
      {dependency.installed
        ? t('admin.plugins.detail.depConflict')
        : dependency.optional
          ? t('admin.plugins.detail.depOptionalMissing')
          : t('admin.plugins.detail.depMissing')}
    </span>
  );
}

function ConsumesBadge({ entry, t }: { entry: PluginConsumesStatus; t: Translator }) {
  const bad = !entry.satisfied && !entry.optional;
  return (
    <span
      className={
        bad
          ? 'rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive'
          : 'rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground'
      }
    >
      {entry.pluginId}:{entry.extensionPoint}
      {bad ? t('admin.plugins.detail.consumesMissing') : ''}
    </span>
  );
}

export default async function AdminPluginDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = createTranslator(await getLocale());
  let plugin: AdminPlugin | null = null;
  let error: string | null = null;
  try {
    const result = await (await getAuthedApiClient()).getAdminPlugins();
    plugin = result.plugins.find((p) => p.id === id) ?? null;
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  if (error) {
    return (
      <main className="w-full space-y-6">
        <PageHeader
          eyebrow={
            <Link
              href="/admin/plugins"
              className="mb-1 inline-flex text-sm text-muted-foreground hover:text-foreground"
            >
              {t('admin.plugins.detail.back')}
            </Link>
          }
          title={t('admin.plugins.detail.title')}
        />
        <p className="text-sm text-destructive">
          {t('admin.plugins.detail.serviceUnavailable', { error })}
        </p>
      </main>
    );
  }

  if (!plugin) {
    return (
      <main className="w-full space-y-6">
        <PageHeader
          eyebrow={
            <Link
              href="/admin/plugins"
              className="mb-1 inline-flex text-sm text-muted-foreground hover:text-foreground"
            >
              {t('admin.plugins.detail.back')}
            </Link>
          }
          title={t('admin.plugins.detail.notFound')}
          description={id}
        />
      </main>
    );
  }

  return (
    <main className="w-full max-w-3xl space-y-6">
      <PageHeader
        eyebrow={
          <Link
            href="/admin/plugins"
            className="mb-1 inline-flex text-sm text-muted-foreground hover:text-foreground"
          >
            {t('admin.plugins.detail.back')}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {plugin.name}
            {plugin.enabled ? (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {t('admin.plugins.detail.enabled')}
              </span>
            ) : (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {t('admin.plugins.detail.disabled')}
              </span>
            )}
            {plugin.source === 'builtin' ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {t('admin.plugins.detail.builtin')}
              </span>
            ) : null}
            {plugin.signed ? (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {t('admin.plugins.detail.signed')}
              </span>
            ) : null}
          </span>
        }
        description={
          <>
            {plugin.description ? <span className="block">{plugin.description}</span> : null}
            <span className="block text-xs">
              {plugin.id} · v{plugin.version}
            </span>
          </>
        }
        actions={
          plugin.frontend.available ? (
            <Button render={<Link href={`/admin/plugins/${plugin.id}/settings`} />} variant="outline">
              {t('admin.plugins.detail.settings')}
            </Button>
          ) : null
        }
      />

      <section className="rounded-lg border bg-card p-4 text-card-foreground">
        <h2 className="text-sm font-semibold">{t('admin.plugins.detail.dependencies')}</h2>
        {plugin.dependencies.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {plugin.dependencies.map((dep) => (
              <DependencyBadge key={dep.id} dependency={dep} t={t} />
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">{t('admin.plugins.detail.none')}</p>
        )}
      </section>

      <section className="rounded-lg border bg-card p-4 text-card-foreground">
        <h2 className="text-sm font-semibold">{t('admin.plugins.detail.extensionPoints')}</h2>
        <div className="mt-2 space-y-3">
          <div>
            <p className="text-xs text-muted-foreground">{t('admin.plugins.detail.consumes')}</p>
            {plugin.consumesStatus.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {plugin.consumesStatus.map((entry) => (
                  <ConsumesBadge
                    key={`${entry.pluginId}:${entry.extensionPoint}`}
                    entry={entry}
                    t={t}
                  />
                ))}
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{t('admin.plugins.detail.none')}</p>
            )}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('admin.plugins.detail.provides')}</p>
            {plugin.provides.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {plugin.provides.map((point) => (
                  <span
                    key={point}
                    className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {point}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{t('admin.plugins.detail.none')}</p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4 text-card-foreground">
        <h2 className="text-sm font-semibold">{t('admin.plugins.detail.permissions')}</h2>
        {plugin.permissions.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {plugin.permissions.map((permission) => (
              <li key={permission} className="font-mono text-xs">
                {permission}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">{t('admin.plugins.detail.none')}</p>
        )}
        {plugin.roleTemplates.length > 0 ? (
          <div className="mt-3 space-y-1">
            {plugin.roleTemplates.map((template) => (
              <p key={template.role} className="text-xs text-muted-foreground">
                {template.role === 'ADMIN'
                  ? t('admin.plugins.detail.roleAdmin')
                  : t('admin.plugins.detail.roleUser')}
                ：{template.permissions.join(', ') || t('admin.plugins.detail.none')}
              </p>
            ))}
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border bg-card p-4 text-card-foreground">
        <h2 className="text-sm font-semibold">{t('admin.plugins.detail.frontendPages')}</h2>
        {plugin.frontend.available && plugin.frontend.pages.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {plugin.frontend.pages.map((page) => (
              <li key={page.path} className="text-sm text-muted-foreground">
                <span className="font-mono text-xs">{page.path}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {plugin.frontend.available
              ? t('admin.plugins.detail.noPages')
              : t('admin.plugins.detail.noFrontend')}
          </p>
        )}
      </section>
    </main>
  );
}
