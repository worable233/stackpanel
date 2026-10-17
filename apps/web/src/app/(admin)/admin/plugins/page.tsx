import { AdminActionsOverview } from '@/components/admin-actions';
import type { AdminPlugin } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { PluginManager } from './plugin-manager';
import { PluginUploadDialog } from './plugin-upload-dialog';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export default async function AdminPluginsPage() {
  const t = createTranslator(await getLocale());
  let plugins: AdminPlugin[] = [];
  let error: string | null = null;
  try {
    const api = await getAuthedApiClient();
    const pluginsResult = await api.getAdminPlugins();
    plugins = pluginsResult.plugins;
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  return (
    <main className="w-full space-y-6">
      <PageHeader
        title={t('admin.plugins.title')}
        description={t('admin.plugins.pageDescription')}
        actions={<PluginUploadDialog />}
      />
      {error ? (
        <p className="text-sm text-destructive">
          {t('admin.plugins.serviceUnavailable', { error })}
        </p>
      ) : (
        <div className="space-y-8">
          <PluginManager plugins={plugins} />
          <AdminActionsOverview />
        </div>
      )}
    </main>
  );
}
