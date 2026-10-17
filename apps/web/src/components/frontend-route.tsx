import { cache, createElement } from 'react';
import { activeThemeCandidate, importFrontendPackage } from '@/lib/slots';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { DEFAULT_PLATFORM_INFO } from '@stackpanel/sdk';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { FrontendScopeRoot } from '@/components/frontend-scope';
import { FrontendRenderBoundary } from '@/components/frontend-render-boundary';
import { apiAssetUrl, getApiClient } from '@/lib/api';
import { getSessionToken } from '@/lib/auth';
import { resolveFallbackRoute, resolveFrontendRoute, type PageResolution } from '@/lib/pages';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

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
  return renderResolution(resolved, actionError, standalone);
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
): Promise<ReactElement> {
  const content = createElement(resolved.component, {
    params: resolved.params,
    settings: resolved.settings,
    data: resolved.data,
    actions: resolved.actions,
    assetsBaseUrl: resolved.assetsBaseUrl ?? getApiClient().baseUrl,
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
  return renderPublicLayout(resolved.layout, scoped, resolved.assetsBaseUrl);
}

export const getPublicThemeLayout = cache(async () => {
  const candidate = await activeThemeCandidate();
  if (!candidate) return undefined;
  const pkg = await importFrontendPackage(candidate.kind, candidate.id, candidate.manifest, candidate.revision);
  return pkg?.layouts?.theme;
});

export async function PublicThemeShell({ children }: { children: React.ReactNode }) {
  const layout = await getPublicThemeLayout();
  return layout ? renderPublicLayout(layout, children) : <>{children}</>;
}

async function renderPublicLayout(
  layout: NonNullable<PageResolution['layout']>,
  page: React.ReactNode,
  assetsBaseUrl?: string,
): Promise<ReactElement> {
  const [navigation, token, platform, categories, brand] = await Promise.all([
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
  ]);
  return createElement(layout, {
    children: page,
    navigation,
    isAuthenticated: token !== null,
    platform,
    categories,
    assetsBaseUrl: assetsBaseUrl ?? getApiClient().baseUrl,
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
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm rounded-lg border bg-card p-6 text-center text-card-foreground shadow-sm">
        <p className="text-sm font-medium">{t('frontend.pageNotFound')}</p>
        <Link
          href="/"
          className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
        >
          {t('frontend.backHome')}
        </Link>
      </div>
    </main>
  );
}
