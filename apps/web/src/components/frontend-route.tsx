import { cache, createElement } from 'react';
import { activeThemeCandidate, importFrontendPackage, readThemeSettings } from '@/lib/slots';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { notFound } from 'next/navigation';
import { apiAssetUrl, getApiClient, KERNEL_BFF_PREFIX } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { resolveFallbackRoute, resolveFrontendRoute, type PageResolution } from '@/lib/pages';
import { getLocale } from '@/i18n/locale';
import { ErrorPage } from '@stackpanel/ui';

const categoryNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    name: z.string(),
    slug: z.string().nullable(),
    description: z.string().nullable(),
    sortOrder: z.number(),
    productCount: z.number(),
    children: z.array(categoryNodeSchema),
  }),
);
const catalogCategoriesSchema = z.object({ categories: z.array(categoryNodeSchema) });

/**
 * Render any user-facing path from theme/plugin page templates. An unmatched
 * path — or one that only matches a `*` fallback template — becomes a real HTTP
 * 404 via `notFound()` (ADR-0011 §6). The themed not-found template is rendered
 * by the `not-found.tsx` boundary instead, so the status code stays honest.
 */
export async function FrontendRoute({
  path,
  params = {},
  fallback = {},
  themeId,
  actionError,
  searchParams = {},
  standalone = false,
}: {
  standalone?: boolean;
  path: string;
  params?: Record<string, string>;
  fallback?: Record<string, unknown>;
  themeId?: string;
  actionError?: string;
  searchParams?: Record<string, string | string[] | undefined>;
}): Promise<ReactElement> {
  const resolved = await resolveFrontendRoute(path, params, fallback, themeId, searchParams);
  if (!resolved || resolved.fallback) notFound();
  return renderResolution(resolved, actionError, standalone, themeId);
}

/**
 * Theme not-found boundary body: renders the active theme's `*` fallback page
 * when it declares one, otherwise the platform default 404 panel.
 */
export async function FrontendFallback(): Promise<ReactElement> {
  const resolved = await resolveFallbackRoute('/');
  if (resolved) return renderResolution(resolved, undefined);
  return <DefaultNotFound />;
}

/** Render a resolved page (and its layout shell) into an element tree. */
async function renderResolution(
  resolved: PageResolution,
  actionError: string | undefined,
  standalone = false,
  themeId?: string,
): Promise<ReactElement> {
  const locale = await getLocale();
  const content = createElement(resolved.component, {
    params: resolved.params,
    settings: resolved.settings,
    data: resolved.data,
    actions: resolved.actions,
    // Same-origin BFF, never the server-only `API_BASE_URL` (see renderPublicLayout).
    assetsBaseUrl: resolved.assetsBaseUrl ?? KERNEL_BFF_PREFIX,
    locale,
  } as never) as unknown as ReactElement;
  const page = actionError ? (
    <>
      <p
        role="alert"
        className="mx-auto mt-4 w-[min(100%-2rem,72rem)] rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {actionError}
      </p>
      {content}
    </>
  ) : (
    content
  );
  if (!resolved.layout) return page;
  const shared = await getPublicThemeLayout();
  if (!standalone && resolved.layout === shared) return page;
  return renderPublicLayout(resolved.layout, page, resolved.assetsBaseUrl, locale, themeId);
}

export const getPublicThemeLayout = cache(async () => {
  const candidate = await activeThemeCandidate();
  if (!candidate) return undefined;
  const pkg = await importFrontendPackage(candidate.kind, candidate.id, candidate.manifest);
  return pkg?.layouts?.theme;
});

export async function PublicThemeShell({ children }: { children: React.ReactNode }) {
  const layout = await getPublicThemeLayout();
  if (!layout) return <>{children}</>;
  return renderPublicLayout(layout, children, undefined, await getLocale());
}

async function renderPublicLayout(
  layout: NonNullable<PageResolution['layout']>,
  page: React.ReactNode,
  assetsBaseUrl?: string,
  locale?: string,
  themeId?: string,
): Promise<ReactElement> {
  const [navigation, token, platform, categories, brand, settings] = await Promise.all([
    getApiClient()
      .getNav('public')
      .then((result) => result.items.map(({ label, href }) => ({ label, href })))
      .catch(() => []),
    getSessionToken(),
    getApiClient()
      .getPlatformInfo()
      .then((result) => result.platform)
      .catch(() => DEFAULT_PLATFORM_INFO),
    getApiClient()
      .get('/catalog/categories', catalogCategoriesSchema)
      .then((result) => result.categories)
      .catch(() => []),
    getApiClient()
      .getPlatformBrand()
      .then((result) => result.brand)
      .catch(() => null),
    themeId
      ? readThemeSettings(themeId)
      : activeThemeCandidate().then((candidate) =>
          candidate ? readThemeSettings(candidate.id) : {},
        ),
  ]);
  return createElement(layout, {
    children: page,
    settings,
    navigation,
    isAuthenticated: token !== null,
    platform,
    categories,
    // Never fall back to `getApiClient().baseUrl`: that is the server-only,
    // host-local address (`http://api:3001` in compose). Rendering it into a
    // browser `src` makes the browser fetch from the user's own machine. The
    // same-origin BFF is the only browser-reachable kernel origin.
    assetsBaseUrl: assetsBaseUrl ?? KERNEL_BFF_PREFIX,
    locale,
    brand: brand
      ? {
          logoUrl: brand.logo ? apiAssetUrl(brand.logo) : null,
          faviconUrl: brand.favicon ? apiAssetUrl(brand.favicon) : null,
        }
      : undefined,
  } as never) as unknown as ReactElement;
}

/** Platform default 404 panel, shown when no theme declares a fallback page. */
export async function DefaultNotFound(): Promise<ReactElement> {
  return <ErrorPage kind="not-found" />;
}
