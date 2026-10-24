import { redirect } from 'next/navigation';
import { z } from 'zod';
import { themeSettingsSchema } from '@/lib/theme-configuration';
import { FrontendRoute } from '@/components/frontend-route';
import { apiAssetUrl, getAuthedApiClient } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function PreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string; path?: string; draft?: string }>;
}) {
  // Preview renders any installed theme/plugin frontend, bypassing the live
  // route gating, and the kernel's preview endpoints are admin-only
  // (`/admin/themes/preview`). Require an admin session before rendering, so an
  // anonymous visitor cannot use `?theme=` to render arbitrary frontends.
  const session = await getSessionUser();
  if (session?.role !== 'ADMIN') redirect('/login?next=/preview');

  const params = await searchParams;
  let themeId = params.theme ?? null;
  if (!themeId) {
    try {
      const api = await getAuthedApiClient();
      themeId = (await api.getThemePreview()).themeId;
    } catch {
      themeId = null;
    }
  }
  const routePath =
    typeof params.path === 'string' && params.path.startsWith('/') ? params.path : '/';

  let settingsOverride;
  if (params.draft === '1' && themeId) {
    const api = await getAuthedApiClient();
    settingsOverride = (await api.get(`/admin/themes/${encodeURIComponent(themeId)}/configuration/preview`, z.object({ settings: themeSettingsSchema.nullable() }))).settings ?? undefined;
  }
  return (
    <>
      {themeId ? (
        <link
          rel="stylesheet"
          href={apiAssetUrl(`/themes/${encodeURIComponent(themeId)}/theme.css`)}
        />
      ) : null}
      <FrontendRoute standalone path={routePath} themeId={themeId ?? undefined} settingsOverride={settingsOverride} />
    </>
  );
}
