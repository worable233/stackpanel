'use client';
import { SectionTitle } from '@stackpanel/ui';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from '@/components/ui/toast';
import type { AdminPlugin, PluginDependencyStatus, StalePluginRecord } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
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
export function PluginManager({
  plugins,
  stale = [],
}: {
  plugins: AdminPlugin[];
  /**
   * Rows whose package directory is gone. They are not loaded, so they cannot be
   * listed as plugins — but until they are removed the database keeps claiming
   * their capabilities/capabilities-providers exist.
   */
  stale?: StalePluginRecord[];
}) {
  const router = useRouter();
  const t = useTranslator();
  const [isMutating, startTransition] = useTransition();

  const mutate = async (form: FormData) => {
    startTransition(async () => {
      const deleting = form.get('_op') === 'delete';
      try {
        if (deleting) {
          await deletePluginAction(form);
          toast.success(t('admin.plugins.deleted'));
        } else {
          await togglePluginAction(form);
          toast.success(t('admin.plugins.toggled'));
        }
        router.refresh();
      } catch {
        toast.error(t('admin.plugins.mutationFailed'));
      }
    });
  };

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>{t('admin.plugins.installed')}</SectionTitle>
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
                {plugin.removable ? (
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={<Button variant="destructive" size="sm" disabled={isMutating} />}
                    >
                      {t('common.delete')}
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('admin.plugins.deleteConfirmTitle')}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t('admin.plugins.deleteConfirmDescription', { name: plugin.name })}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          onClick={() => {
                            const form = new FormData();
                            form.set('_op', 'delete');
                            form.set('id', plugin.id);
                            void mutate(form);
                          }}
                        >
                          {t('common.delete')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
      {stale.length > 0 ? (
        <section>
          <SectionTitle>{t('admin.plugins.stale.title')}</SectionTitle>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('admin.plugins.stale.description')}
          </p>
          <ul className="mt-3 space-y-2">
            {stale.map((record) => (
              <li
                key={record.id}
                className="flex items-center justify-between rounded-lg border bg-card p-4 text-card-foreground"
              >
                <div>
                  <p className="font-medium">
                    {record.name}
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {record.id}@{record.version}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('admin.plugins.stale.body')}
                  </p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isMutating}
                  onClick={() => {
                    const form = new FormData();
                    form.set('_op', 'delete');
                    form.set('id', record.id);
                    void mutate(form);
                  }}
                >
                  {t('admin.plugins.stale.cleanup')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
