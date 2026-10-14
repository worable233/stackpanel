import { redirect } from 'next/navigation';
import { z } from 'zod';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { LoginForm } from './login-form';
import { apiAssetUrl, getApiClient } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';

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
      providers={providers}
      platformName={platform.name}
      logoSrc={brand?.logo ? apiAssetUrl(brand.logo) : null}
      posts={posts}
    />
  );
}
