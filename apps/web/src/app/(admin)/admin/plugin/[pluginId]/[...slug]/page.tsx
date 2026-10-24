import { redirect } from 'next/navigation';
import { AdminActions } from '@/components/admin-actions';
import { AdminPluginPage } from '@/components/admin-plugin-page';
import { resolvePluginAdminRoute } from '@/lib/admin-frontend';

export const dynamic = 'force-dynamic';

export default async function PluginAdminRoute({
  params,
}: {
  params: Promise<{ pluginId: string; slug: string[] }>;
}) {
  const { pluginId, slug } = await params;
  const path = `/${slug.join('/')}`;
  const result = await resolvePluginAdminRoute(pluginId, path);
  if (result.status === 'ok' && result.settingsHref) redirect(result.settingsHref);
  return (
    <>
      <AdminPluginPage
        pluginId={pluginId}
        path={path}
        result={result}
      />
      <AdminActions pluginId={pluginId} />
    </>
  );
}
