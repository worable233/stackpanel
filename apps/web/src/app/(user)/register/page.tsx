import { redirect } from 'next/navigation';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { RegisterForm } from './register-form';
import { apiAssetUrl, getApiClient } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';

export default async function RegisterPage() {
  const session = await getSessionUser();
  if (session) {
    redirect(session.role === 'ADMIN' ? '/admin' : '/account');
  }
  const api = getApiClient();
  const [providers, platform, brand] = await Promise.all([
    api
      .getOAuthProviders()
      .then((result) => result.providers)
      .catch(() => []),
    api
      .getPlatformInfo()
      .then((result) => result.platform)
      .catch(() => DEFAULT_PLATFORM_INFO),
    api
      .getPlatformBrand()
      .then((result) => result.brand)
      .catch(() => null),
  ]);
  return (
    <RegisterForm
      providers={providers}
      platformName={platform.name}
      platformDescription={platform.description}
      logoSrc={brand?.logo ? apiAssetUrl(brand.logo) : null}
    />
  );
}
