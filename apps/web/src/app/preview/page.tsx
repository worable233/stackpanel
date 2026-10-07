import { FrontendRoute } from '@/components/frontend-route';
import { apiAssetUrl, getAuthedApiClient } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function PreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string; path?: string }>;
}) {
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

  return (
    <>
      {themeId ? (
        <link
          rel="stylesheet"
          href={apiAssetUrl(`/themes/${encodeURIComponent(themeId)}/theme.css`)}
        />
      ) : null}
      <FrontendRoute path={routePath} themeId={themeId ?? undefined} />
    </>
  );
}
