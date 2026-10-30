import { PageHeader } from '@stackpanel/ui';
import { Settings2 } from 'lucide-react';
import { SettingsForm } from '@/components/settings-form';
import { getAuthedApiClient } from '@/lib/api';
import { savePluginSettingsAction } from '@/lib/frontend-settings-actions';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { localizeSettingsSchema, readPackageMessages } from '@/i18n/package-messages';
import { listPluginFrontendCandidates } from '@/lib/slots';

export const dynamic = 'force-dynamic';

export default async function AdminPluginSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const locale = await getLocale();
  const t = createTranslator(locale);
  const api = await getAuthedApiClient();
  const [schemaResult, settingsResult, candidates] = await Promise.all([
    api.getPluginSettingsSchema(id),
    api.getPluginSettings(id),
    listPluginFrontendCandidates(),
  ]);
  // Resolve the plugin's own settings labels through its catalog (ADR-0016 §5).
  const candidate = candidates.find((item) => item.id === id);
  const { messages } = readPackageMessages(id, candidate?.manifest.messages);
  const schema = schemaResult.schema
    ? localizeSettingsSchema(schemaResult.schema, messages, locale, [DEFAULT_LOCALE])
    : null;

  return (
    <main className="w-full space-y-6">
      <PageHeader
        backHref="/admin/plugins"
        backLabel={t('admin.pluginSettings.back')}
        title={t('admin.pluginSettings.title')}
      />
      <div>
        {schema ? (
          <SettingsForm
            schema={schema}
            initial={settingsResult.settings}
            save={savePluginSettingsAction.bind(null, id)}
          />
        ) : (
          <div className="flex max-w-xl flex-col items-center gap-3 rounded-2xl bg-muted/40 px-6 py-12 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-background text-muted-foreground">
              <Settings2 className="size-5" aria-hidden="true" />
            </span>
            <p className="text-sm text-muted-foreground">
              {t('admin.pluginSettings.noSettings')}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
