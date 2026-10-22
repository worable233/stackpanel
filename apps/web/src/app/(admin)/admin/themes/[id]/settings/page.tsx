import { PageHeader } from '@stackpanel/ui';
import { ThemeJsonEditor } from '@/components/theme-json-editor';
import { themeConfigurationSchema } from '@/lib/theme-configuration';
import { getAuthedApiClient } from '@/lib/api';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { DEFAULT_LOCALE } from '@/i18n/config';
import type { FrontendSettingsSchema } from '@stackpanel/sdk';
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
  const [schemaResult, candidate] = await Promise.all([
    api.getThemeSettingsSchema(id),
    themeFrontendCandidate(id),
  ]);
  // The schema's labels are declared by the theme; resolve them through the
  // theme's own catalog so the admin form follows the interface language
  // (ADR-0016 §5).
  const { messages } = readPackageMessages(id, candidate?.manifest.messages);
  const configuration = schemaResult.schema
    ? ((await api.get(
        `/admin/themes/${encodeURIComponent(id)}/configuration`,
        themeConfigurationSchema,
      )) as unknown as import('@/lib/theme-configuration').ThemeConfiguration)
    : null;
  const schema = schemaResult.schema
    ? localizeSettingsSchema(schemaResult.schema, messages, locale, [DEFAULT_LOCALE])
    : null;

  return (
    <main className="w-full space-y-6">
      <PageHeader
        backHref="/admin/themes"
        backLabel={t('admin.themeSettings.back')}
        title={t('admin.themeSettings.title')}
      />
      <div>
        {schema && configuration ? (
          <ThemeJsonEditor
            themeId={id}
            schema={schema}
            configuration={{ ...configuration, schema: schema as FrontendSettingsSchema }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t('admin.themeSettings.noSettings')}</p>
        )}
      </div>
    </main>
  );
}
