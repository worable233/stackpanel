import { redirect } from 'next/navigation';
import { z } from 'zod';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { LoginForm } from './login-form';
import { apiAssetUrl, getApiClient } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';
import { safeInternalPath } from '@/lib/safe-path';

const postsSchema = z.object({
  items: z.array(
    z.object({
      title: z.string(),
      excerpt: z.string().optional().default(''),
      path: z.string(),
      publishedAt: z.string().nullable().optional(),
    }),
  ),
});

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const safeNext = safeInternalPath(next);
  const session = await getSessionUser();
  if (session) {
    redirect(safeNext ?? (session.role === 'ADMIN' ? '/admin' : '/account'));
  }
  const nextPath = safeNext ?? undefined;
  const api = getApiClient();
  // A fresh instance has no admin yet: route the operator to the wizard instead
  // of a login form that cannot succeed. Best-effort — an unreachable API just
  // renders login as before.
  const setup = await api.getSetupStatus().catch(() => null);
  if (setup?.required) redirect('/setup');
  const [providers, platform, brand, posts] = await Promise.all([
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
    api
      .get('/cms/posts?page=1&pageSize=2', postsSchema)
      .then((result) => result.items)
      .catch(() => []),
  ]);
  return (
    <LoginForm
      nextPath={nextPath}
      oauthError={error === 'oauth'}
      providers={providers}
      platformName={platform.name}
      logoSrc={brand?.logo ? apiAssetUrl(brand.logo) : null}
      posts={posts}
    />
  );
}
