import Link from 'next/link';
import { PageHeader } from '@stackpanel/ui';
import { SettingsForm } from '@/components/settings-form';
import { getAuthedApiClient } from '@/lib/api';
import { savePluginSettingsAction } from '@/lib/frontend-settings-actions';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

export default async function AdminPluginSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = createTranslator(await getLocale());
  const api = await getAuthedApiClient();
  const [schemaResult, settingsResult] = await Promise.all([
    api.getPluginSettingsSchema(id),
    api.getPluginSettings(id),
  ]);
  const schema = schemaResult.schema;

  return (
    <main className="w-full space-y-6">
      <PageHeader
        eyebrow={
          <Link
            href="/admin/plugins"
            className="mb-1 inline-flex text-sm text-muted-foreground hover:text-foreground"
          >
            {t('admin.pluginSettings.back')}
          </Link>
        }
        title={t('admin.pluginSettings.title')}
        description={id}
      />
      <div>
        {schema ? (
          <SettingsForm
            schema={schema}
            initial={settingsResult.settings}
            save={savePluginSettingsAction.bind(null, id)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t('admin.pluginSettings.noSettings')}</p>
        )}
      </div>
    </main>
  );
}
