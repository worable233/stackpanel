import Link from 'next/link';
import type { AdminPlugin, PluginDependencyStatus, PluginConsumesStatus } from '@stackpanel/sdk';
import { Badge, List, ListEmpty, ListItem, PageHeader, SectionTitle } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { Button } from '@/components/ui/button';
import { getLocale } from '@/i18n/locale';
import { createTranslator, type Translator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

function DependencyBadge({ dependency, t }: { dependency: PluginDependencyStatus; t: Translator }) {
  const range = dependency.range ? `@${dependency.range}` : '';
  const unsatisfied = !dependency.satisfied;
  return (
    <Badge variant={unsatisfied ? 'destructive' : 'outline'} className="font-normal">
      {dependency.id}
      {range}
      {unsatisfied
        ? dependency.installed
          ? t('admin.plugins.detail.depConflict')
          : dependency.optional
            ? t('admin.plugins.detail.depOptionalMissing')
            : t('admin.plugins.detail.depMissing')
        : null}
    </Badge>
  );
}

function ConsumesBadge({ entry, t }: { entry: PluginConsumesStatus; t: Translator }) {
  const bad = !entry.satisfied && !entry.optional;
  return (
    <Badge variant={bad ? 'destructive' : 'outline'} className="font-normal">
      {entry.pluginId}:{entry.extensionPoint}
      {bad ? t('admin.plugins.detail.consumesMissing') : ''}
    </Badge>
  );
}

function DetailSection({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="rounded-2xl bg-muted/40 p-5">
      <SectionTitle>{title}</SectionTitle>
      <div className="mt-3">{children}</div>
    </section>
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
    plugin = result.plugins.find((candidate) => candidate.id === id) ?? null;
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  if (error) {
    return (
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <PageHeader
          backHref="/admin/plugins"
          backLabel={t('admin.plugins.detail.back')}
          title={t('admin.plugins.detail.title')}
        />
        <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t('admin.plugins.detail.serviceUnavailable')}
        </p>
      </main>
    );
  }

  if (!plugin) {
    return (
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <PageHeader
          backHref="/admin/plugins"
          backLabel={t('admin.plugins.detail.back')}
          title={t('admin.plugins.detail.notFound')}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <PageHeader
        backHref="/admin/plugins"
        backLabel={t('admin.plugins.detail.back')}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {plugin.name}
            <Badge variant={plugin.enabled ? 'secondary' : 'outline'}>
              {plugin.enabled
                ? t('admin.plugins.detail.enabled')
                : t('admin.plugins.detail.disabled')}
            </Badge>
            {plugin.source === 'builtin' ? (
              <Badge variant="outline">{t('admin.plugins.detail.builtin')}</Badge>
            ) : null}
            {plugin.signed ? (
              <Badge variant="secondary">{t('admin.plugins.detail.signed')}</Badge>
            ) : null}
          </span>
        }
        actions={
          plugin.frontend.available ? (
            <Button
              render={<Link href={`/admin/plugins/${plugin.id}/settings`} />}
              variant="outline"
            >
              {t('admin.plugins.detail.settings')}
            </Button>
          ) : null
        }
      />

      <DetailSection title={t('admin.plugins.detail.dependencies')}>
        {plugin.dependencies.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {plugin.dependencies.map((dependency) => (
              <DependencyBadge key={dependency.id} dependency={dependency} t={t} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('admin.plugins.detail.none')}</p>
        )}
      </DetailSection>

      <DetailSection title={t('admin.plugins.detail.extensionPoints')}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{t('admin.plugins.detail.consumes')}</p>
            {plugin.consumesStatus.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {plugin.consumesStatus.map((entry) => (
                  <ConsumesBadge
                    key={`${entry.pluginId}:${entry.extensionPoint}`}
                    entry={entry}
                    t={t}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('admin.plugins.detail.none')}</p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{t('admin.plugins.detail.provides')}</p>
            {plugin.provides.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {plugin.provides.map((point) => (
                  <Badge key={point} variant="secondary" className="bg-background font-mono font-normal">
                    {point}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('admin.plugins.detail.none')}</p>
            )}
          </div>
        </div>
      </DetailSection>

      <DetailSection title={t('admin.plugins.detail.permissions')}>
        {plugin.permissions.length > 0 ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {plugin.permissions.map((permission) => (
                <Badge key={permission} variant="secondary" className="bg-background font-mono font-normal">
                  {permission}
                </Badge>
              ))}
            </div>
            {plugin.roleTemplates.length > 0 ? (
              <div className="flex flex-col gap-2 rounded-xl bg-background/70 p-3">
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
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('admin.plugins.detail.none')}</p>
        )}
      </DetailSection>

      <DetailSection title={t('admin.plugins.detail.frontendPages')}>
        {plugin.frontend.available && plugin.frontend.pages.length > 0 ? (
          <List>
            {plugin.frontend.pages.map((page) => (
              <ListItem key={page.path} className="bg-background/70 px-3 py-2.5">
                <span className="font-mono text-xs text-muted-foreground">{page.path}</span>
              </ListItem>
            ))}
          </List>
        ) : (
          <List>
            <ListEmpty>
              {plugin.frontend.available
                ? t('admin.plugins.detail.noPages')
                : t('admin.plugins.detail.noFrontend')}
            </ListEmpty>
          </List>
        )}
      </DetailSection>
    </main>
  );
}
