import { AdminActions } from '@/components/admin-actions';
import { AdminPluginPage } from '@/components/admin-plugin-page';
import { resolvePluginAdminRoute } from '@/lib/admin-frontend';

export const dynamic = 'force-dynamic';

export default async function PluginAdminRoot({
  params,
}: {
  params: Promise<{ pluginId: string }>;
}) {
  const { pluginId } = await params;
  const result = await resolvePluginAdminRoute(pluginId, '/');
  return (
    <>
      <AdminPluginPage pluginId={pluginId} path="/" result={result} />
      <AdminActions pluginId={pluginId} />
    </>
  );
}
