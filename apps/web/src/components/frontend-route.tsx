import { cache, createElement } from 'react';
import {
  activeThemeCandidate,
  importFrontendPackage,
  listPluginFrontendCandidates,
  readThemeSettings,
} from '@/lib/slots';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import type { FrontendSettings } from '@stackpanel/sdk';
import { notFound } from 'next/navigation';
import { FrontendScopeRoot } from '@/components/frontend-scope';
import { FrontendRenderBoundary } from '@/components/frontend-render-boundary';
import { apiAssetUrl, getApiClient, KERNEL_BFF_PREFIX } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { resolveFallbackRoute, resolveFrontendRoute, type PageResolution } from '@/lib/pages';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
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
  searchParams = {},
  standalone = false,
  settingsOverride,
}: {
  standalone?: boolean;
  settingsOverride?: FrontendSettings;
  path: string;
  params?: Record<string, string>;
  fallback?: Record<string, unknown>;
  themeId?: string;
  searchParams?: Record<string, string | string[] | undefined>;
}): Promise<ReactElement> {
  const resolved = await resolveFrontendRoute(path, params, fallback, themeId, searchParams, settingsOverride);
  if (!resolved || resolved.fallback) notFound();
  return renderResolution(resolved, standalone, themeId, settingsOverride);
}

/**
 * Theme not-found boundary body: renders the active theme's `*` fallback page
 * when it declares one, otherwise the platform default 404 panel.
 */
export async function FrontendFallback(): Promise<ReactElement> {
  const resolved = await resolveFallbackRoute('/');
  if (resolved) return renderResolution(resolved);
  return <DefaultNotFound />;
}

/** Render a resolved page (and its layout shell) into an element tree. */
async function renderResolution(
  resolved: PageResolution,
  standalone = false,
  themeId?: string,
  settingsOverride?: FrontendSettings,
): Promise<ReactElement> {
  const locale = await getLocale();
  const content = createElement(resolved.component, {
    params: resolved.params,
    settings: settingsOverride ?? resolved.settings,
    data: resolved.data,
    actions: resolved.actions,
    // Same-origin BFF, never the server-only `API_BASE_URL` (see renderPublicLayout).
    assetsBaseUrl: resolved.assetsBaseUrl ?? KERNEL_BFF_PREFIX,
    locale,
  } as never) as unknown as ReactElement;
  // Action results are toasted once by `<ActionFeedbackToaster />`; rendering
  // `?error=` inline here duplicated the same message on public pages.
  const page = content;
  // Contract 05 §3.3: wrap the package's render root in a stable scope marker so
  // its `styles[]` selectors can be scoped to its own DOM. `display: contents`
  // means the wrapper generates no box, so the package's layout is unchanged.
  // Contract 05 §3.5: the provider also routes the package's portals into a
  // scope-marked container so overlays stay inside its style scope.
  const scoped = resolved.owner ? (
    <FrontendScopeRoot scope={`${resolved.owner.kind}:${resolved.owner.id}`}>
      {/* Contract 06 §1.3: a package that throws while rendering degrades to an
          inline notice instead of taking down the host shell. */}
      <FrontendRenderBoundary label={`${resolved.owner.kind}:${resolved.owner.id}`}>
        {page}
      </FrontendRenderBoundary>
    </FrontendScopeRoot>
  ) : (
    page
  );
  if (!resolved.layout) return scoped;
  const shared = await getPublicThemeLayout();
  if (!standalone && resolved.layout === shared) return scoped;
  return renderPublicLayout(resolved.layout, scoped, resolved.assetsBaseUrl, locale, themeId, settingsOverride);
}

export const getPublicThemeLayout = cache(async () => {
  const candidate = await activeThemeCandidate();
  if (!candidate) return undefined;
  const pkg = await importFrontendPackage(candidate.kind, candidate.id, candidate.manifest, candidate.revision);
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
  settingsOverride?: FrontendSettings,
): Promise<ReactElement> {
  const [navigation, token, platform, categories, brand, settings, pluginCandidates] = await Promise.all([
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
    settingsOverride
      ? Promise.resolve(settingsOverride)
      : themeId
      ? readThemeSettings(themeId)
      : activeThemeCandidate().then((candidate) =>
          candidate ? readThemeSettings(candidate.id) : {},
        ),
    listPluginFrontendCandidates().catch(() => []),
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
    plugins: pluginCandidates.map((candidate) => candidate.id),
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
  const t = createTranslator(await getLocale());
  return (
    <ErrorPage
      kind="not-found"
      content={{
        title: t('errorPage.notFound.title'),
        description: t('errorPage.notFound.description'),
      }}
    />
  );
}
