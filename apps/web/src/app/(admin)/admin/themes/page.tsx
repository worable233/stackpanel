import { Suspense } from 'react';
import type { AdminTheme } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { DataSkeleton } from '@/components/data-skeletons';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { ThemeManager } from './theme-manager';
import { ThemeUploadDialog } from './theme-upload-dialog';
import { getLocale } from '@/i18n/locale';
import { createTranslator, type Translator } from '@/i18n/core';

export default async function AdminThemesPage() {
  const t = createTranslator(await getLocale());
  return (
    <main className="flex w-full flex-col gap-6">
      <PageHeader title={t('admin.themes.title')} actions={<ThemeUploadDialog />} />
      <Suspense fallback={<DataSkeleton variant="themes" rows={4} />}>
        <ThemesData t={t} />
      </Suspense>
    </main>
  );
}

async function ThemesData({ t }: { t: Translator }) {
  let themes: AdminTheme[] = [];
  let previewThemeId: string | null = null;
  let error: string | null = null;
  try {
    const api = await getAuthedApiClient();
    const [result, preview] = await Promise.all([api.getAdminThemes(), api.getThemePreview()]);
    themes = result.themes;
    previewThemeId = preview.themeId;
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  if (error) {
    return <p className="text-sm text-destructive">{t('admin.themes.serviceUnavailable')}</p>;
  }

  return <ThemeManager themes={themes} previewThemeId={previewThemeId} />;
}
