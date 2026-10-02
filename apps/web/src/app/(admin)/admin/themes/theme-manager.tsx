'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AdminTheme } from '@stackpanel/sdk';
import { Button } from '@/components/ui/button';
import {
  activateThemeAction,
  clearPreviewThemeAction,
  deleteThemeAction,
  previewThemeAction,
} from '@/lib/theme-actions';
import { useTranslator } from '@/i18n/provider';

/** Interactive theme manager: upload a ZIP, activate or delete a theme. */
export function ThemeManager({
  themes,
  previewThemeId,
}: {
  themes: AdminTheme[];
  previewThemeId: string | null;
}) {
  const router = useRouter();
  const t = useTranslator();
  const [isMutating, startTransition] = useTransition();

  return (
    <div className="space-y-8">
      {previewThemeId ? (
        <section className="flex items-center justify-between rounded-lg border bg-accent/40 p-4">
          <div>
            <p className="text-sm font-medium">
              {t('admin.themes.previewing', {
                name: themes.find((theme) => theme.id === previewThemeId)?.name ?? previewThemeId,
              })}
            </p>
            <p className="text-xs text-muted-foreground">{t('admin.themes.previewHint')}</p>
          </div>
          <form
            action={async () => {
              startTransition(async () => {
                await clearPreviewThemeAction();
                router.refresh();
              });
            }}
          >
            <Button type="submit" variant="outline" size="sm" disabled={isMutating}>
              {t('admin.themes.exitPreview')}
            </Button>
          </form>
        </section>
      ) : null}
      <section>
        <h2 className="text-lg font-semibold">{t('admin.themes.installed')}</h2>
        <ul className="mt-3 space-y-2">
          {themes.map((theme) => (
            <li
              key={theme.id}
              className="flex items-center justify-between rounded-lg border bg-card p-4 text-card-foreground"
            >
              <div>
                <p className="font-medium">
                  {theme.name}
                  {theme.active ? (
                    <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                      {t('admin.themes.active')}
                    </span>
                  ) : null}
                  {theme.isDefault ? (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {t('admin.themes.default')}
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {theme.id} · v{theme.version}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {theme.frontend.available
                    ? t('admin.themes.frontendPages', { count: theme.frontend.pages.length })
                    : t('admin.themes.frontendNone')}
                  {' · '}
                  {theme.signed ? t('admin.themes.signed') : t('admin.themes.unsigned')}
                </p>
                {theme.locales.length > 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('admin.themes.locales', { locales: theme.locales.join(', ') })}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {theme.frontend.available ? (
                  <>
                    <Button
                      render={<Link href={`/admin/themes/${theme.id}/settings`} />}
                      variant="outline"
                      size="sm"
                    >
                      {t('admin.themes.settings')}
                    </Button>
                    <form
                      action={async () => {
                        const form = new FormData();
                        form.set('id', theme.id);
                        await previewThemeAction(form);
                        router.push('/preview');
                      }}
                    >
                      <Button type="submit" variant="outline" size="sm" disabled={isMutating}>
                        {t('admin.themes.preview')}
                      </Button>
                    </form>
                  </>
                ) : null}
                {!theme.active ? (
                  <form
                    action={async () => {
                      startTransition(async () => {
                        const form = new FormData();
                        form.set('id', theme.id);
                        await activateThemeAction(form);
                        router.refresh();
                      });
                    }}
                  >
                    <Button type="submit" variant="outline" size="sm" disabled={isMutating}>
                      {t('admin.themes.activate')}
                    </Button>
                  </form>
                ) : null}
                {!theme.isDefault && !theme.active ? (
                  <form
                    action={async () => {
                      startTransition(async () => {
                        const form = new FormData();
                        form.set('id', theme.id);
                        await deleteThemeAction(form);
                        router.refresh();
                      });
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
