import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { SetupForm } from './setup-form';
import { apiAssetUrl, getApiClient } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '初始化',
  robots: { index: false, follow: false },
};

/**
 * First-run setup wizard. Server-rendered gate: the page only exists while the
 * instance has no administrator. Once claimed (or when setup is disabled) it
 * redirects away, so it never lingers as an anonymous write surface.
 */
export default async function SetupPage() {
  const api = getApiClient();
  const status = await api.getSetupStatus().catch(() => null);
  if (!status || !status.required) {
    // Already initialized (or the API is unreachable): send to login. A session,
    // if any, goes to its workspace like the login page does.
    const session = await getSessionUser();
    redirect(session ? (session.role === 'ADMIN' ? '/admin' : '/account') : '/login');
  }

  const [platform, brand] = await Promise.all([
    api.getPlatformInfo().then((r) => r.platform).catch(() => DEFAULT_PLATFORM_INFO),
    api.getPlatformBrand().then((r) => r.brand).catch(() => null),
  ]);

  return (
    <SetupForm
      platformName={platform.name}
      logoSrc={brand?.logo ? apiAssetUrl(brand.logo) : null}
      tokenRequired={status.tokenRequired}
    />
  );
}
