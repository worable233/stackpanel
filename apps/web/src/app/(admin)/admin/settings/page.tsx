import { AdminPluginPage } from '@/components/admin-plugin-page';
import { getPluginSettingsSections } from '@/lib/admin-frontend';
import {
  DEFAULT_PLATFORM_INFO,
  type AdminCurrencyDefinitionView,
  type AdminFxRateView,
  type DistributionSourceConfig,
  type PlatformBrand,
  type PlatformInfo,
  type SettlementCurrencyResponse,
  type SigningStatus,
} from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { Separator } from '@/components/ui/separator';
import { apiAssetUrl, getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { SettingsManager } from './settings-manager';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  const pluginSettings = await getPluginSettingsSections();
  const t = createTranslator(await getLocale());
  let platform: PlatformInfo = DEFAULT_PLATFORM_INFO;
  let signing: SigningStatus | null = null;
  let brand: PlatformBrand | null = null;
  let currency:
    (SettlementCurrencyResponse & { currencies?: AdminCurrencyDefinitionView[] }) | null = null;
  let rates: AdminFxRateView[] = [];
  let distribution: DistributionSourceConfig | null = null;
  let distributionDefaults: { repository: string | null; mirror: string | null } | undefined;
  let error: string | null = null;
  try {
    const api = await getAuthedApiClient();
    const [
      platformResult,
      signingResult,
      brandResult,
      currencyResult,
      catalogResult,
      rateResult,
      distributionResult,
    ] = await Promise.all([
      api.getAdminPlatformInfo(),
      api.getSigningStatus(),
      api.getPlatformBrand(),
      api.getSettlementCurrency(),
      api.getAdminCurrencyDefinitions(),
      api.getAdminCurrencyRates(),
      api.getDistributionSource(),
    ]);
    platform = platformResult.platform;
    signing = signingResult.signing;
    brand = brandResult.brand;
    currency = { ...currencyResult, currencies: catalogResult.currencies };
    rates = rateResult.rates;
    distribution = distributionResult.source;
    distributionDefaults = distributionResult.defaults;
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  const brandAssets = brand
    ? {
        logoUrl: brand.logo ? apiAssetUrl(brand.logo) : null,
        faviconUrl: brand.favicon ? apiAssetUrl(brand.favicon) : null,
      }
    : null;

  return (
    <main className="w-full">
      <PageHeader title={t('admin.settings.title')} />
      <Separator className="my-4 lg:my-6" />
      {error ? (
        <p className="text-sm text-destructive">
          {t('admin.settings.serviceUnavailable')}
        </p>
      ) : (
        <SettingsManager
          platform={platform}
          signing={signing}
          brand={brandAssets}
          currency={currency}
          currencyRates={rates}
          distribution={distribution}
          distributionDefaults={distributionDefaults}
          pluginSections={pluginSettings.map((section) => ({
            id: section.id,
            title: section.title,
            content: (
              <AdminPluginPage
                pluginId={section.pluginId}
                path={section.path}
                result={section.result}
                embedded
              />
            ),
          }))}
        />
      )}
    </main>
  );
}
