import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { AdminActions } from '@/components/admin-actions';
import { AdminPluginPage } from '@/components/admin-plugin-page';
import { DataSkeleton } from '@/components/data-skeletons';
import { resolvePluginAdminRoute } from '@/lib/admin-frontend';

export const dynamic = 'force-dynamic';

export default async function PluginAdminRoute({
  params,
}: {
  params: Promise<{ pluginId: string; slug: string[] }>;
}) {
  const { pluginId, slug } = await params;
  const path = `/${slug.join('/')}`;
  return (
    <main className="flex w-full flex-col gap-4">
      <Suspense fallback={<DataSkeleton variant="detail" />}>
        <PluginAdminRouteContent pluginId={pluginId} path={path} />
      </Suspense>
    </main>
  );
}

async function PluginAdminRouteContent({ pluginId, path }: { pluginId: string; path: string }) {
  const result = await resolvePluginAdminRoute(pluginId, path);
  if (result.status === 'ok' && result.settingsHref) redirect(result.settingsHref);
  return (
    <>
      <AdminPluginPage pluginId={pluginId} path={path} result={result} />
      <AdminActions pluginId={pluginId} />
    </>
  );
}
