import { Suspense } from 'react';
import { AdminActions } from '@/components/admin-actions';
import { AdminPluginPage } from '@/components/admin-plugin-page';
import { DataSkeleton } from '@/components/data-skeletons';
import { resolvePluginAdminRoute } from '@/lib/admin-frontend';

export const dynamic = 'force-dynamic';

export default async function PluginAdminRoot({
  params,
}: {
  params: Promise<{ pluginId: string }>;
}) {
  const { pluginId } = await params;
  return (
    <main className="flex w-full flex-col gap-4">
      <Suspense fallback={<DataSkeleton variant="detail" />}>
        <PluginAdminRootContent pluginId={pluginId} />
      </Suspense>
    </main>
  );
}

async function PluginAdminRootContent({ pluginId }: { pluginId: string }) {
  const result = await resolvePluginAdminRoute(pluginId, '/');
  return (
    <>
      <AdminPluginPage pluginId={pluginId} path="/" result={result} />
      <AdminActions pluginId={pluginId} />
    </>
  );
}
