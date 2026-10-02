import type { MarketPackage } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { MarketSection } from '@/components/market-section';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export default async function AdminMarketPage() {
  const t = createTranslator(await getLocale());
  let plugins: MarketPackage[] = [];
  let themes: MarketPackage[] = [];
  let error: string | null = null;
  try {
    const api = await getAuthedApiClient();
    const [pluginResult, themeResult] = await Promise.all([
      api.getMarketPlugins(),
      api.getMarketThemes(),
    ]);
    plugins = pluginResult.plugins;
    themes = themeResult.themes;
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  return (
    <main className="w-full space-y-6">
      <PageHeader
        title={t('admin.market.title')}
        description={t('admin.market.description')}
      />
      {error ? (
        <p className="text-sm text-destructive">
          {t('admin.market.serviceUnavailable', { error })}
        </p>
      ) : (
        <div className="space-y-8">
          <MarketSection title={t('admin.market.plugins')} packages={plugins} />
          <MarketSection title={t('admin.market.themes')} packages={themes} />
        </div>
      )}
    </main>
  );
}
