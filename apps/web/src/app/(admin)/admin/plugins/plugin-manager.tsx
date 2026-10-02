'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AdminPlugin, PluginDependencyStatus } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import { deletePluginAction, togglePluginAction } from '@/lib/plugin-actions';
import { useTranslator } from '@/i18n/provider';
import type { Translator } from '@/i18n/core';

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
      <span className="rounded-full bg-muted px-2 py-0.5">
        {dependency.id}
        {range}
      </span>
    );
  }
  if (dependency.installed) {
    return (
      <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
        {dependency.id}
        {range}
        {t('admin.plugins.detail.depConflict')}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
      {dependency.id}
      {range}
      {dependency.optional
        ? t('admin.plugins.detail.depOptionalMissing')
        : t('admin.plugins.detail.depMissing')}
    </span>
  );
}

/** Interactive plugin manager: enable/disable or remove a plugin. */
export function PluginManager({ plugins }: { plugins: AdminPlugin[] }) {
  const router = useRouter();
  const t = useTranslator();
  const [isMutating, startTransition] = useTransition();

  const mutate = async (form: FormData) => {
    startTransition(async () => {
      if (form.get('_op') === 'delete') {
        await deletePluginAction(form);
      } else {
        await togglePluginAction(form);
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-lg font-semibold">{t('admin.plugins.installed')}</h2>
        <ul className="mt-3 space-y-2">
          {plugins.map((plugin) => (
            <li
              key={plugin.id}
              className="flex items-center justify-between rounded-lg border bg-card p-4 text-card-foreground"
            >
              <div>
                <p className="font-medium">
                  {plugin.name}
                  {plugin.enabled ? (
                    <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                      {t('admin.plugins.enabled')}
                    </span>
                  ) : (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {t('admin.plugins.disabled')}
                    </span>
                  )}
                  {plugin.source === 'builtin' ? (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {t('admin.plugins.builtin')}
                    </span>
                  ) : null}
                  {plugin.signed ? (
                    <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                      {t('admin.plugins.signed')}
                    </span>
                  ) : null}
                </p>
                {plugin.description ? (
                  <p className="mt-1 text-sm text-muted-foreground">{plugin.description}</p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {plugin.id} · v{plugin.version}
                  {plugin.frontend.available
                    ? ` · ${t('admin.plugins.frontendPages', { count: plugin.frontend.pages.length })}`
                    : ''}
                </p>
                {plugin.dependencies.length > 0 ? (
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{t('admin.plugins.dependencies')}</span>
                    {plugin.dependencies.map((dep) => (
                      <DependencyBadge key={dep.id} dependency={dep} t={t} />
                    ))}
                  </p>
                ) : null}
                {plugin.consumesStatus.length > 0 ? (
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{t('admin.plugins.extensionPoints')}</span>
                    {plugin.consumesStatus.map((entry) => {
                      const key = `${entry.pluginId}:${entry.extensionPoint}`;
                      const bad = !entry.satisfied && !entry.optional;
                      return (
                        <span
                          key={key}
                          className={
                            bad
                              ? 'rounded-full bg-destructive/10 px-2 py-0.5 text-destructive'
                              : 'rounded-full bg-muted px-2 py-0.5'
                          }
                        >
                          {entry.pluginId}:{entry.extensionPoint}
                          {bad ? t('admin.plugins.detail.consumesMissing') : ''}
                        </span>
                      );
                    })}
                  </p>
                ) : null}
                {plugin.provides.length > 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('admin.plugins.provides')}
                    {plugin.provides.join(', ')}
                  </p>
                ) : null}
                {plugin.locales.length > 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('admin.plugins.locales', { locales: plugin.locales.join(', ') })}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  render={<Link href={`/admin/plugins/${plugin.id}`} />}
                  variant="outline"
                  size="sm"
                >
                  {t('admin.plugins.detailTrigger')}
                </Button>
                {plugin.frontend.available ? (
                  <Button
                    render={<Link href={`/admin/plugins/${plugin.id}/settings`} />}
                    variant="outline"
                    size="sm"
                  >
                    {t('admin.plugins.settings')}
                  </Button>
                ) : null}
                <form
                  action={async () => {
                    const form = new FormData();
                    form.set('_op', 'toggle');
                    form.set('id', plugin.id);
                    form.set('enabled', plugin.enabled ? 'false' : 'true');
                    await mutate(form);
                  }}
                >
                  <Button type="submit" variant="outline" size="sm" disabled={isMutating}>
                    {plugin.enabled ? t('admin.plugins.disable') : t('admin.plugins.enable')}
                  </Button>
                </form>
                {plugin.source === 'dynamic' ? (
                  <form
                    action={async () => {
                      const form = new FormData();
                      form.set('_op', 'delete');
                      form.set('id', plugin.id);
                      await mutate(form);
                    }}
                  >
                    <Button type="submit" variant="destructive" size="sm" disabled={isMutating}>
                      {t('common.delete')}
                    </Button>
                  </form>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
