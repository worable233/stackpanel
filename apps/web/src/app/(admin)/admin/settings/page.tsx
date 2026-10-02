import {
  DEFAULT_PLATFORM_INFO,
  type PlatformBrand,
  type PlatformInfo,
  type SigningStatus,
} from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { apiAssetUrl, getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { SettingsManager } from './settings-manager';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  const t = createTranslator(await getLocale());
  let platform: PlatformInfo = DEFAULT_PLATFORM_INFO;
  let signing: SigningStatus | null = null;
  let brand: PlatformBrand | null = null;
  let error: string | null = null;
  try {
    const api = await getAuthedApiClient();
    const [platformResult, signingResult, brandResult] = await Promise.all([
      api.getAdminPlatformInfo(),
      api.getSigningStatus(),
      api.getPlatformBrand(),
    ]);
    platform = platformResult.platform;
    signing = signingResult.signing;
    brand = brandResult.brand;
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
    <main className="w-full space-y-6">
      <PageHeader
        title={t('admin.settings.title')}
        description={t('admin.settings.pageDescription')}
      />
      {error ? (
        <p className="text-sm text-destructive">
          {t('admin.settings.serviceUnavailable', { error })}
        </p>
      ) : (
        <SettingsManager platform={platform} signing={signing} brand={brandAssets} />
      )}
    </main>
  );
}
