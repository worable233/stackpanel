import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import type { AccountUser } from '@stackpanel/sdk';
import { AccountPluginPage } from '@/components/account-plugin-page';
import { DataSkeleton } from '@/components/data-skeletons';
import { getAuthedApiClient } from '@/lib/api';
import { resolvePluginAccountRoute } from '@/lib/account-frontend';
import { stripFeedbackParams } from '@/lib/feedback-params';
import { requestCurrentUser } from '@/lib/shell-request-cache';

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
  const path = `/${slug.join('/')}`;
  // 宿主反馈参数（`error`/`success`/`flash`）不传给插件页面：插件的
  // `searchParams` 是它自己的输入面，不该承载宿主的提示通道。
  const pluginQuery = flattenSearchParams(stripFeedbackParams(query));

  return (
    <main className="flex w-full flex-col gap-4">
      <Suspense fallback={<DataSkeleton variant="detail" />}>
        <PluginAccountContent path={path} pluginQuery={pluginQuery} />
      </Suspense>
    </main>
  );
}

async function PluginAccountContent({
  path,
  pluginQuery,
}: {
  path: string;
  pluginQuery: Record<string, string>;
}) {
  await getAuthedApiClient();
  let currentUser;
  try {
    currentUser = await requestCurrentUser();
  } catch {
    redirect(`/login?next=/account${path}`);
  }
  const user: AccountUser = {
    id: currentUser.user.id,
    email: currentUser.user.email,
    role: currentUser.user.role,
  };
  const result = await resolvePluginAccountRoute(path, user, pluginQuery);
  return (
    <AccountPluginPage
      pluginId={result.status === 'ok' ? result.pluginId : 'unknown'}
      path={path}
      user={user}
      result={result}
      searchParams={pluginQuery}
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
