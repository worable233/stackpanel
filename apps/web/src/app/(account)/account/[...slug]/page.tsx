import { redirect } from 'next/navigation';
import type { AccountUser } from '@stackpanel/sdk';
import { AccountPluginPage } from '@/components/account-plugin-page';
import { getAuthedApiClient } from '@/lib/api';
import { resolvePluginAccountRoute } from '@/lib/account-frontend';

export const dynamic = 'force-dynamic';

export default async function PluginAccountRoute({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const api = await getAuthedApiClient();
  let currentUser;
  try {
    currentUser = await api.getCurrentUser();
  } catch {
    redirect(`/login?next=/account/${slug.map(encodeURIComponent).join('/')}`);
  }
  const user: AccountUser = {
    id: currentUser.user.id,
    email: currentUser.user.email,
    role: currentUser.user.role,
  };
  const path = `/${slug.join('/')}`;
  const result = await resolvePluginAccountRoute(path, user, flattenSearchParams(query));
  return (
    <AccountPluginPage
      pluginId={result.status === 'ok' ? result.pluginId : 'unknown'}
      path={path}
      user={user}
      result={result}
      searchParams={flattenSearchParams(query)}
    />
  );
}

/** Collapse `searchParams` to plain strings (first value wins; `error` is handled separately). */
function flattenSearchParams(
  query: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') result[key] = first;
  }
  return result;
}

