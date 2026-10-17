import Link from 'next/link';
import { PageHeader } from '@stackpanel/ui';
import { SettingsForm } from '@/components/settings-form';
import { getAuthedApiClient } from '@/lib/api';
import { saveThemeSettingsAction } from '@/lib/frontend-settings-actions';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { localizeSettingsSchema, readPackageMessages } from '@/i18n/package-messages';
import { themeFrontendCandidate } from '@/lib/slots';

export const dynamic = 'force-dynamic';

export default async function AdminThemeSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const locale = await getLocale();
  const t = createTranslator(locale);
  const api = await getAuthedApiClient();
  const [schemaResult, settingsResult, candidate] = await Promise.all([
    api.getThemeSettingsSchema(id),
    api.getThemeSettings(id),
    themeFrontendCandidate(id),
  ]);
  // The schema's labels are declared by the theme; resolve them through the
  // theme's own catalog so the admin form follows the interface language
  // (ADR-0016 §5).
  const { messages } = readPackageMessages(id, candidate?.manifest.messages);
  const schema = schemaResult.schema
    ? localizeSettingsSchema(schemaResult.schema, messages, locale, [DEFAULT_LOCALE])
    : null;

  return (
    <main className="w-full space-y-6">
      <PageHeader
        eyebrow={
          <Link
            href="/admin/themes"
            className="mb-1 inline-flex text-sm text-muted-foreground hover:text-foreground"
          >
            {t('admin.themeSettings.back')}
          </Link>
        }
        title={t('admin.themeSettings.title')}
      />
      <div>
        {schema ? (
          <SettingsForm
            schema={schema}
            initial={settingsResult.settings}
            save={saveThemeSettingsAction.bind(null, id)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t('admin.themeSettings.noSettings')}</p>
        )}
      </div>
    </main>
  );
}
