'use client';
import { SectionTitle } from '@stackpanel/ui';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AdminTheme } from '@stackpanel/sdk';
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
import { toast } from '@/components/ui/toast';
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
                try {
                  await clearPreviewThemeAction();
                  toast.success(t('admin.themes.previewCleared'));
                  router.refresh();
                } catch {
                  toast.error(t('admin.themes.previewFailed'));
                }
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
        <SectionTitle>{t('admin.themes.installed')}</SectionTitle>
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
                        try {
                          await previewThemeAction(form);
                          router.push('/preview');
                        } catch {
                          toast.error(t('admin.themes.previewFailed'));
                        }
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
                        try {
                          await activateThemeAction(form);
                          toast.success(t('admin.themes.activateSuccess'));
                          router.refresh();
                        } catch {
                          toast.error(t('admin.themes.activateFailed'));
                        }
                      });
                    }}
                  >
                    <Button type="submit" variant="outline" size="sm" disabled={isMutating}>
                      {t('admin.themes.activate')}
                    </Button>
                  </form>
                ) : null}
                {!theme.isDefault && !theme.active ? (
                  <AlertDialog>
                    <AlertDialogTrigger
                      render={<Button variant="destructive" size="sm" disabled={isMutating} />}
                    >
                      {t('common.delete')}
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t('admin.themes.deleteConfirmTitle')}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t('admin.themes.deleteConfirmDescription', { name: theme.name })}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          onClick={() => {
                            const form = new FormData();
                            form.set('id', theme.id);
                            startTransition(async () => {
                              try {
                                await deleteThemeAction(form);
                                toast.success(t('admin.themes.deleted'));
                                router.refresh();
                              } catch {
                                toast.error(t('admin.themes.deleteFailed'));
                              }
                            });
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
    </div>
  );
}
