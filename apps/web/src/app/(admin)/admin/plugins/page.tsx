import type { AdminPlugin, StalePluginRecord } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { PluginManager } from './plugin-manager';
import { PluginUploadDialog } from './plugin-upload-dialog';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export default async function AdminPluginsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; updates?: string }>;
}) {
  const t = createTranslator(await getLocale());
  const params = await searchParams;
  let plugins: AdminPlugin[] = [];
  let stale: StalePluginRecord[] = [];
  let error: string | null = null;
  try {
    const api = await getAuthedApiClient();
    const pluginsResult = await api.getAdminPlugins();
    plugins = pluginsResult.plugins;
    stale = pluginsResult.stale ?? [];
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  return (
    <main className="flex w-full flex-col gap-6">
      <PageHeader title={t('admin.plugins.title')} actions={<PluginUploadDialog />} />
      {error ? (
        <p className="text-sm text-destructive">
          {t('admin.plugins.serviceUnavailable')}
        </p>
      ) : (
        <PluginManager
          plugins={plugins}
          stale={stale}
          initialTab={params.tab === 'market' ? 'market' : 'installed'}
          onlyUpgradable={params.updates === '1'}
        />
      )}
    </main>
  );
}
