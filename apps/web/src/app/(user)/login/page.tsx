import { redirect } from 'next/navigation';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { LoginForm } from './login-form';
import { apiAssetUrl, getApiClient } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const session = await getSessionUser();
  if (session) {
    redirect(
      typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')
        ? next
        : session.role === 'ADMIN'
          ? '/admin'
          : '/account',
    );
  }
  const nextPath =
    typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : undefined;
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
    <LoginForm
      nextPath={nextPath}
      providers={providers}
      platformName={platform.name}
      platformDescription={platform.description}
      logoSrc={brand?.logo ? apiAssetUrl(brand.logo) : null}
    />
  );
}
