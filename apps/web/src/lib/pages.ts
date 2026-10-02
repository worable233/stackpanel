import 'server-only';
import type {
  FinderProvider,
  FrontendLayoutComponent,
  FrontendActionExecutors,
  FrontendPageComponent,
  FrontendPageDataRequirement,
  FrontendPageDefinition,
  FrontendPackage,
  FrontendSettings,
  FrontendPageSource,
} from '@stackpanel/sdk';
import {
  captureFrontendPathParams,
  resolveFrontendPageSource,
  resolveThemeOverride,
  selectFrontendPageDefinition,
} from '@stackpanel/sdk';
import { getApiClient, getAuthedApiClient } from './api';
import { getSessionUser } from './auth';
import {
  activeThemeCandidate,
  importFrontendPackage,
  listPluginFrontendCandidates,
  readPluginSettings,
  readThemeSettings,
  themeFrontendCandidate,
  type FrontendCandidate,
} from './slots';
import { bindPluginActions } from './frontend-plugin-actions';

export interface PageResolution {
  component: FrontendPageComponent;
  layout: FrontendLayoutComponent | null;
  settings: FrontendSettings;
  data: Record<string, unknown>;
  params: Record<string, string>;
  source: FrontendPageSource;
  actions: FrontendActionExecutors;
  assetsBaseUrl?: string;
  /**
   * True when the match came from a `*`/`/**` fallback pattern (the theme's
   * "not-found template") rather than an explicit page. The route shell turns
   * this into a real HTTP 404 (ADR-0011 §6).
   */
  fallback: boolean;
}

interface FinderEntry {
  provider: FinderProvider;
  pluginId?: string;
}

type FinderRegistry = Record<string, FinderEntry>;

/**
 * Resolve any user-facing path against theme/plugin page templates. The
 * platform is a rendering host; it does not provide business-page fallbacks.
 */
export async function resolveFrontendRoute(
  path: string,
  params: Record<string, string> = {},
  fallback: Record<string, unknown> = {},
  themeId?: string,
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<PageResolution | null> {
  const [theme, pluginCandidates] = await Promise.all([
    themeId ? themeFrontendCandidate(themeId) : activeThemeCandidate(),
    listPluginFrontendCandidates(),
  ]);
  const themePages = theme?.manifest.pages ?? [];
  const pluginPages = pluginCandidates.flatMap((candidate) => candidate.manifest.pages ?? []);
  const source = resolveFrontendPageSource(themePages, pluginPages, path);

  const themePkg = theme ? await safeImportFrontend(theme) : null;
  const pluginPkgs = await Promise.all(
    pluginCandidates.map((candidate) => safeImportFrontend(candidate)),
  );
  const finders = collectFinders([
    { pkg: themePkg },
    ...pluginCandidates.map((candidate, index) => ({
      pkg: pluginPkgs[index] ?? null,
      pluginId: candidate.id,
    })),
  ]);

  if (source === 'theme' && theme) {
    const definition = findPageDefinition(themePages, path);
    const component = definition ? themePkg?.pageComponents?.[definition.component] : null;
    if (component && definition) {
      const routeParams = pageParams(definition.path, path, params);
      const settings = await readThemeSettings(theme.id);
      return {
        component,
        layout: definition.layout ? (themePkg?.layouts?.[definition.layout] ?? null) : null,
        settings,
        data: await executePageData(
          definition,
          finders,
          routeParams,
          settings,
          fallback,
          searchParams,
        ),
        params: routeParams,
        source,
        fallback: isFallbackPagePattern(definition.path),
        // Themes may render pages that borrow plugin actions (e.g. a themed
        // storefront using store.* cart/checkout actions). Bind them all so
        // the theme page keeps interactivity while owning the visual shell.
        actions: bindAllPluginActions(pluginCandidates, path),
        assetsBaseUrl: `${getApiClient().baseUrl}/themes/${theme.id}/assets`,
      };
    }
  }

  if (source === 'plugin') {
    let owner: FrontendCandidate | null = null;
    let definition: FrontendPageDefinition | undefined;
    let pkg: FrontendPackage | null = null;
    let bestScore = Number.MIN_SAFE_INTEGER;
    for (let index = 0; index < pluginCandidates.length; index += 1) {
      const candidate = pluginCandidates[index];
      const candidateDefinition = findPageDefinition(candidate.manifest.pages, path);
      if (!candidateDefinition) continue;
      // Prefer the most specific pattern across plugins: an explicit `/shop`
      // must beat another plugin's `*` fallback regardless of candidate order.
      const score = frontendPathSpecificity(candidateDefinition.path);
      if (score > bestScore) {
        bestScore = score;
        owner = candidate;
        definition = candidateDefinition;
        pkg = pluginPkgs[index] ?? null;
      }
    }
    // A theme may override the plugin page's component while keeping the
    // plugin's data requirements, finders and actions intact.
    const overrideComponentId = resolveThemeOverride(themePkg?.overrides, path);
    const component = overrideComponentId
      ? themePkg?.pageComponents?.[overrideComponentId]
      : definition && pkg
        ? pkg.pageComponents?.[definition.component]
        : null;
    if (component && owner && definition && pkg) {
      const routeParams = pageParams(definition.path, path, params);
      const settings = await readPluginSettings(owner.id);
      return {
        component,
        // Themes own the public shell. A plugin may supply a local layout only
        // when no active theme exposes the conventional `theme` layout.
        layout:
          themePkg?.layouts?.['theme'] ??
          (definition.layout ? (pkg.layouts?.[definition.layout] ?? null) : null),
        settings,
        data: await executePageData(
          definition,
          finders,
          routeParams,
          settings,
          fallback,
          searchParams,
        ),
        params: routeParams,
        source,
        fallback: isFallbackPagePattern(definition.path),
        actions: bindPluginActions(owner.id, owner.manifest.actions, path),
      };
    }
  }

  return null;
}

function findPageDefinition(
  pages: readonly FrontendPageDefinition[],
  path: string,
): FrontendPageDefinition | undefined {
  return selectFrontendPageDefinition(pages, path);
}

/** Whether a matched page pattern is a theme/plugin `*` fallback (not-found). */
function isFallbackPagePattern(pattern: string): boolean {
  return pattern === '*' || pattern === '/**';
}

/**
 * Resolve the theme's (then a plugin's) `*` fallback page into a renderable
 * resolution for the not-found boundary (ADR-0011 §6). Returns `null` when none
 * declares one, so the boundary falls back to the platform default 404.
 *
 * A 404 template carries no route data of its own, so `data` stays empty; the
 * shell still binds the theme layout and any plugin actions so a themed 404 can
 * keep its chrome and navigation.
 */
export async function resolveFallbackRoute(path = '/'): Promise<PageResolution | null> {
  const [theme, pluginCandidates] = await Promise.all([
    activeThemeCandidate(),
    listPluginFrontendCandidates(),
  ]);
  const themeDefinition = (theme?.manifest.pages ?? []).find((page) =>
    isFallbackPagePattern(page.path),
  );
  const themePkg = theme ? await safeImportFrontend(theme) : null;
  if (themeDefinition && theme) {
    const component = themePkg?.pageComponents?.[themeDefinition.component];
    if (component) {
      return {
        component,
        layout: themeDefinition.layout
          ? (themePkg?.layouts?.[themeDefinition.layout] ?? null)
          : null,
        settings: await readThemeSettings(theme.id),
        data: {},
        params: pageParams(themeDefinition.path, path, {}),
        source: 'theme',
        fallback: true,
        actions: bindAllPluginActions(pluginCandidates, path),
        assetsBaseUrl: `${getApiClient().baseUrl}/themes/${theme.id}/assets`,
      };
    }
  }
  for (const candidate of pluginCandidates) {
    const definition = (candidate.manifest.pages ?? []).find((page) =>
      isFallbackPagePattern(page.path),
    );
    if (!definition) continue;
    const pkg = await safeImportFrontend(candidate);
    const component = pkg?.pageComponents?.[definition.component];
    if (!component) continue;
    return {
      component,
      layout:
        themePkg?.layouts?.['theme'] ??
        (definition.layout ? (pkg?.layouts?.[definition.layout] ?? null) : null),
      settings: await readPluginSettings(candidate.id),
      data: {},
      params: pageParams(definition.path, path, {}),
      source: 'plugin',
      fallback: true,
      actions: bindPluginActions(candidate.id, candidate.manifest.actions, path),
    };
  }
  return null;
}

/** Bind every plugin's actions onto a theme-rendered page. */
function bindAllPluginActions(
  candidates: FrontendCandidate[],
  returnPath: string,
): FrontendActionExecutors {
  const bound: FrontendActionExecutors = {};
  for (const candidate of candidates) {
    const actions = candidate.manifest.actions;
    if (!actions || actions.length === 0) continue;
    const executor = bindPluginActions(candidate.id, actions, returnPath);
    for (const [id, action] of Object.entries(executor)) {
      if (!bound[id]) bound[id] = action;
    }
  }
  return bound;
}

/** Rank a path pattern so cross-plugin candidates pick the most concrete one. */
function frontendPathSpecificity(pattern: string): number {
  if (pattern === '*' || pattern === '/**') return -1;
  return pattern
    .split('/')
    .filter(Boolean)
    .reduce(
      (score, segment) =>
        score + (segment === '*' || segment === '**' ? 0 : segment.startsWith(':') ? 1 : 2),
      0,
    );
}

function pageParams(
  pattern: string,
  path: string,
  provided: Record<string, string>,
): Record<string, string> {
  return Object.keys(provided).length > 0 ? provided : captureFrontendPathParams(pattern, path);
}

async function safeImportFrontend(candidate: FrontendCandidate): Promise<FrontendPackage | null> {
  try {
    return await importFrontendPackage(candidate.kind, candidate.id, candidate.manifest);
  } catch {
    return null;
  }
}

function collectFinders(
  packages: Array<{ pkg: FrontendPackage | null; pluginId?: string }>,
): FinderRegistry {
  const result: FinderRegistry = {};
  for (const { pkg, pluginId } of packages) {
    if (!pkg?.finders) continue;
    for (const [name, finder] of Object.entries(pkg.finders)) {
      // Theme-owned finders are registered first. A plugin cannot silently
      // replace a theme's data provider just by reusing its name.
      if (!result[name]) {
        result[name] = { provider: finder, ...(pluginId ? { pluginId } : {}) };
      }
    }
  }
  return result;
}

async function executePageData(
  definition: FrontendPageDefinition,
  finders: FinderRegistry,
  params: Record<string, string>,
  settings: FrontendSettings,
  fallback: Record<string, unknown>,
  searchParams: Record<string, string | string[] | undefined>,
): Promise<Record<string, unknown>> {
  const data = { ...fallback };
  if (!definition.data || definition.data.length === 0) return data;
  const [api, session] = await Promise.all([getAuthedApiClient(), getSessionUser()]);
  const resolved = await Promise.all(
    definition.data.map(async (requirement) => {
      if (requirement.permission) {
        if (!session) return null;
        try {
          const check = await api.checkPermission(requirement.permission);
          if (!check.allowed) return null;
        } catch {
          return null;
        }
      }
      const finder = finders[requirement.finder];
      if (!finder) return null;
      try {
        const value = await finder.provider.handler(
          resolveInput(requirement, params, searchParams),
          {
            params,
            settings,
            api,
            session,
          },
        );
        if (finder.pluginId) {
          void api
            .recordFrontendAudit('frontend.finder.call', finder.pluginId, requirement.finder, {
              status: 'ok',
            })
            .catch(() => undefined);
        }
        return [requirement.as, value] as const;
      } catch {
        if (finder.pluginId) {
          void api
            .recordFrontendAudit('frontend.finder.call', finder.pluginId, requirement.finder, {
              status: 'error',
            })
            .catch(() => undefined);
        }
        return null;
      }
    }),
  );
  for (const entry of resolved) {
    if (entry) data[entry[0]] = entry[1];
  }
  return data;
}

function resolveInput(
  requirement: FrontendPageDataRequirement,
  params: Record<string, string>,
  searchParams: Record<string, string | string[] | undefined>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(requirement.input ?? {})) {
    if (key === '$query') {
      // 把整份 query string 传给 finder（可配置商品计价预览等动态场景）。
      result['$query'] = searchParams;
      continue;
    }
    if (typeof value === 'string' && value.startsWith(':')) {
      result[key] = params[value.slice(1)] ?? value;
      continue;
    }
    // A matching URL query parameter overrides the manifest default, so pages
    // like a catalog can read `?page=2` for server-side pagination.
    const query = searchParams[key];
    if (query !== undefined) {
      result[key] = Array.isArray(query) ? (query[0] ?? value) : query;
      continue;
    }
    result[key] = value;
  }
  return result;
}
