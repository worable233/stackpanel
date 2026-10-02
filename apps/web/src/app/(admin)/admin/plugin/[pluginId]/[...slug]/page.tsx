import { AdminActions } from '@/components/admin-actions';
import { AdminPluginPage } from '@/components/admin-plugin-page';
import { resolvePluginAdminRoute } from '@/lib/admin-frontend';

export const dynamic = 'force-dynamic';

export default async function PluginAdminRoute({
  params,
  searchParams,
}: {
  params: Promise<{ pluginId: string; slug: string[] }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { pluginId, slug } = await params;
  const path = `/${slug.join('/')}`;
  const result = await resolvePluginAdminRoute(pluginId, path);
  const { error } = await searchParams;
  return (
    <>
      <AdminPluginPage
        pluginId={pluginId}
        path={path}
        result={result}
        actionError={readActionError(error)}
      />
      <AdminActions pluginId={pluginId} />
    </>
  );
}

function readActionError(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
}
