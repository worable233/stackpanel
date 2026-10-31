import { AdminPluginPage } from '@/components/admin-plugin-page';
import { getPluginSettingsSections } from '@/lib/admin-frontend';
import {
  DEFAULT_PLATFORM_INFO,
  type AdminCurrencyDefinitionView,
  type AdminRuntimeConfigEntry,
  type AdminSalesChannel,
  type AdminSalesChannelListResponse,
  type AdminFxRateView,
  type DistributionSourceConfig,
  type PlatformBrand,
  type PlatformInfo,
  type SettlementCurrencyResponse,
  type SigningStatus,
  type UpdatePolicyView,
} from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
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
  let updatePolicy: UpdatePolicyView | null = null;
  let salesChannels: AdminSalesChannel[] = [];
  let paymentProviders: NonNullable<AdminSalesChannelListResponse['providers']> = [];
  let runtimeConfig: AdminRuntimeConfigEntry[] = [];
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
      salesChannelsResult,
      updatePolicyResult,
      runtimeConfigResult,
    ] = await Promise.all([
      api.getAdminPlatformInfo(),
      api.getSigningStatus(),
      api.getPlatformBrand(),
      api.getSettlementCurrency(),
      api.getAdminCurrencyDefinitions(),
      api.getAdminCurrencyRates(),
      api.getDistributionSource(),
      // Payment methods live on the admin sales API. A failure here must not
      // blank the whole settings page, so it is recovered per-panel below.
      api.getAdminSalesChannels().catch(() => ({
        channels: [] as AdminSalesChannel[],
        providers: [] as NonNullable<AdminSalesChannelListResponse['providers']>,
      })),
      // 更新策略是独立设置项：它失败不能把整个设置页清空（与销售渠道同样的降级策略）。
      api.getUpdatePolicy().catch(() => null),
      // 运行期配置（ADR-0026）同样是独立面板：老版本内核没有这个接口，降级成不显示，
      // 而不是让整个设置页报错。
      api.getAdminConfig().catch(() => ({ entries: [] as AdminRuntimeConfigEntry[] })),
    ]);
    platform = platformResult.platform;
    signing = signingResult.signing;
    brand = brandResult.brand;
    currency = { ...currencyResult, currencies: catalogResult.currencies };
    rates = rateResult.rates;
    distribution = distributionResult.source;
    distributionDefaults = distributionResult.defaults;
    salesChannels = salesChannelsResult.channels;
    paymentProviders = salesChannelsResult.providers ?? [];
    updatePolicy = updatePolicyResult?.policy ?? null;
    runtimeConfig = runtimeConfigResult?.entries ?? [];
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
      <div className="h-5 lg:h-6" />
      {error ? (
        <p className="text-sm text-destructive">{t('admin.settings.serviceUnavailable')}</p>
      ) : (
        <SettingsManager
          platform={platform}
          signing={signing}
          brand={brandAssets}
          currency={currency}
          currencyRates={rates}
          distribution={distribution}
          distributionDefaults={distributionDefaults}
          updatePolicy={updatePolicy}
          runtimeConfig={runtimeConfig}
          salesChannels={salesChannels}
          paymentProviders={paymentProviders}
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
