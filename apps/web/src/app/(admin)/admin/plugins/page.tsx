import { Suspense } from 'react';
import type { AdminPlugin, StalePluginRecord } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { DataSkeleton } from '@/components/data-skeletons';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { PluginManager } from './plugin-manager';
import { PluginUploadDialog } from './plugin-upload-dialog';
import { getLocale } from '@/i18n/locale';
import { createTranslator, type Translator } from '@/i18n/core';

export default async function AdminPluginsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; updates?: string }>;
}) {
  const t = createTranslator(await getLocale());
  const params = await searchParams;
  return (
    <main className="flex w-full flex-col gap-6">
      <PageHeader title={t('admin.plugins.title')} actions={<PluginUploadDialog />} />
      <Suspense fallback={<DataSkeleton variant="plugins" rows={8} />}>
        <PluginsData
          initialTab={params.tab === 'market' ? 'market' : 'installed'}
          onlyUpgradable={params.updates === '1'}
          t={t}
        />
      </Suspense>
    </main>
  );
}

async function PluginsData({
  initialTab,
  onlyUpgradable,
  t,
}: {
  initialTab: 'installed' | 'market';
  onlyUpgradable: boolean;
  t: Translator;
}) {
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

  if (error) {
    return <p className="text-sm text-destructive">{t('admin.plugins.serviceUnavailable')}</p>;
  }

  return (
    <PluginManager
      plugins={plugins}
      stale={stale}
      initialTab={initialTab}
      onlyUpgradable={onlyUpgradable}
    />
  );
}
