import type { AdminTheme } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { ThemeManager } from './theme-manager';
import { ThemeUploadDialog } from './theme-upload-dialog';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export default async function AdminThemesPage() {
  const t = createTranslator(await getLocale());
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

  return (
    <main className="w-full space-y-6">
      <PageHeader
        title={t('admin.themes.title')}
        description={t('admin.themes.description')}
        actions={<ThemeUploadDialog />}
      />
      {error ? (
        <p className="text-sm text-destructive">
          {t('admin.themes.serviceUnavailable', { error })}
        </p>
      ) : (
        <ThemeManager themes={themes} previewThemeId={previewThemeId} />
      )}
    </main>
  );
}
