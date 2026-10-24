import 'server-only';
import type { FrontendSettings } from '@stackpanel/sdk';
import type {
  FinderProvider,
  FrontendActionExecutors,
  FrontendManifest,
  FrontendPageDataRequirement,
} from '@stackpanel/sdk';
import { matchFrontendPagePath } from '@stackpanel/sdk';
import { getAuthedApiClient } from './api';
import {
  candidateAdmitsServerExecution,
  importFrontendPackage,
  listPluginFrontendCandidates,
  readPluginSettings,
} from './slots';
import { runtimeAdminModuleUrl, runtimeFrontendLoadingEnabled } from './frontend-runtime';
import { getLocale } from '@/i18n/locale';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { packageLabel, readPackageMessages } from '@/i18n/package-messages';
import { bindPluginActions } from './frontend-plugin-actions';

export interface PluginAdminMenu {
  pluginId: string;
  label: string;
  href: string;
  group?: string;
  order?: number;
  activePaths?: string[];
}

export type PluginAdminRouteResult =
  | {
      status: 'ok';
      settingsHref?: string;
      pluginId: string;
      componentId: string;
      settings: FrontendSettings;
      data: Record<string, unknown>;
      actions: FrontendActionExecutors;
      params: Record<string, string>;
      /**
       * Stage 4 M2: when runtime loading is enabled, the same-origin browser URL of
       * the plugin's compiled admin entry, so the client container can load it at
       * request time instead of via the build-time client registry.
       */
      runtimeAdminModuleUrl?: string;
    }
  | { status: 'denied'; permission: string }
  | { status: 'not-found' };

/** Admin sidebar menus contributed by active plugin frontend packages. */
export async function getPluginAdminMenus(): Promise<PluginAdminMenu[]> {
  const candidates = await listPluginFrontendCandidates();
  const menus: PluginAdminMenu[] = [];
  const api = await getAuthedApiClient();
  const locale = await getLocale();
  for (const candidate of candidates) {
    const { messages } = readPackageMessages(candidate.id, candidate.manifest.messages);
    for (const route of candidate.manifest.adminRoutes) {
      if (
        route.systemSettings ||
        !route.nav ||
        (route.permission && !(await isAllowed(api, route.permission)))
      )
        continue;
      // Labels are resolved through the package's own catalog (ADR-0016 §5).
      // The literal `label` stays the fallback for locales the package omits.
      const group = packageLabel(
        messages,
        locale,
        route.nav.groupKey,
        route.nav.group,
        [DEFAULT_LOCALE],
      );
      menus.push({
        pluginId: candidate.id,
        label: packageLabel(messages, locale, route.nav.labelKey, route.nav.label, [DEFAULT_LOCALE]),
        href: pluginAdminHref(candidate.id, route.path),
        order: route.nav.order,
        activePaths: route.nav.activePaths?.map((path) => pluginAdminHref(candidate.id, path)),
        ...(group ? { group } : {}),
      });
    }
  }
  return menus;
}

/** Resolve a plugin admin route and enforce its declared permission. */
export async function resolvePluginAdminRoute(
  pluginId: string,
  path: string,
  returnPath?: string,
): Promise<PluginAdminRouteResult> {
  const candidates = await listPluginFrontendCandidates();
  const candidate = candidates.find((item) => item.id === pluginId);
  if (!candidate) return { status: 'not-found' };
  const route = candidate.manifest.adminRoutes.find((item) =>
    matchFrontendPagePath(item.path, path),
  );
  if (!route) return { status: 'not-found' };
  if (route.permission) {
    const api = await getAuthedApiClient();
    const check = await api.checkPermission(route.permission);
    if (!check.allowed) return { status: 'denied', permission: route.permission };
  }
  const pkg = await importFrontendPackage('plugins', pluginId, candidate.manifest, candidate.revision);
  if (!pkg) return { status: 'not-found' };
  // 合并所有已加载插件的前端 finders，使 admin 页面可跨插件复用数据提供者
  // （例如 store 的商品管理页读取 catalog 的分类数据）。
  const mergedFinders: Record<string, FinderProvider> = {};
  for (const item of candidates) {
    // Trust boundary (contract 03 §3.1): an unauthorized package's finder must
    // not be registered for execution in the web process.
    if (!candidateAdmitsServerExecution(item)) continue;
    const candidatePkg = await importFrontendPackage('plugins', item.id, item.manifest, item.revision);
    if (!candidatePkg?.finders) continue;
    for (const [name, finder] of Object.entries(candidatePkg.finders)) {
      if (!mergedFinders[name]) mergedFinders[name] = finder;
    }
  }
  const settings = await readPluginSettings(pluginId);
  const params = capturePathParams(route.path, path);
  try {
    const api = await getAuthedApiClient();
    await api.recordFrontendAudit('frontend.admin.route.render', pluginId, path, {
      route: route.path,
    });
  } catch {
    // Rendering should not fail because an audit write was rejected.
  }
  return {
    status: 'ok',
    settingsHref: route.systemSettings ? pluginSettingsHref(pluginId, route.path) : undefined,
    pluginId,
    componentId: route.component,
    settings,
    data: await executeRouteData(route.data ?? [], mergedFinders, params, settings),
    actions: bindPluginActions(
      pluginId,
      candidate.manifest.actions,
      returnPath ?? `/admin/plugin/${pluginId}${path}`,
    ),
    params,
    // Only point the runtime container at an artifact the package actually ships
    // (contract 04 §2). A package built before runtime loading has only
    // `dist/admin.js`, which the browser cannot resolve (bare host-ABI
    // specifiers). The kernel back-fills `admin.runtime.js` for such packages;
    // if it could not (e.g. a genuinely unresolvable third-party import), fall
    // through to the platform "not found" UI instead of emitting a URL that is
    // guaranteed to 404.
    ...(runtimeFrontendLoadingEnabled() && shipsRuntimeAdminEntry(candidate.manifest)
      ? { runtimeAdminModuleUrl: runtimeAdminModuleUrl('plugins', pluginId, candidate.revision) }
      : {}),
  };
}

/** Whether the package declares the browser-loadable admin entry in `files[]`. */
function shipsRuntimeAdminEntry(manifest: FrontendManifest): boolean {
  return (manifest.files ?? []).includes('frontend/dist/admin.runtime.js');
}

function pluginAdminHref(pluginId: string, routePath: string): string {
  const normalized = routePath === '/' ? '' : routePath;
  return `/admin/plugin/${encodeURIComponent(pluginId)}${normalized}`;
}

function capturePathParams(pattern: string, path: string): Record<string, string> {
  const patternSegments = pattern.split('/').filter((segment) => segment.length > 0);
  const pathSegments = path.split('/').filter((segment) => segment.length > 0);
  const params: Record<string, string> = {};
  patternSegments.forEach((segment, index) => {
    if (segment.startsWith(':')) params[segment.slice(1)] = pathSegments[index] ?? '';
  });
  return params;
}

async function executeRouteData(
  requirements: FrontendPageDataRequirement[],
  finders: Record<string, FinderProvider>,
  params: Record<string, string>,
  settings: FrontendSettings,
): Promise<Record<string, unknown>> {
  const api = await getAuthedApiClient();
  const values = await Promise.all(
    requirements.map(async (requirement) => {
      if (requirement.permission && !(await isAllowed(api, requirement.permission))) return null;
      const finder = finders[requirement.finder];
      if (!finder) return null;
      try {
        return [
          requirement.as,
          await finder.handler(resolveFinderInput(requirement, params), {
            params,
            settings,
            api,
            session: { role: 'ADMIN' },
          }),
        ] as const;
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(
    values.filter((value): value is readonly [string, unknown] => value !== null),
  );
}

async function isAllowed(
  api: Awaited<ReturnType<typeof getAuthedApiClient>>,
  permission: string,
): Promise<boolean> {
  try {
    return (await api.checkPermission(permission)).allowed;
  } catch {
    return false;
  }
}

function resolveFinderInput(
  requirement: FrontendPageDataRequirement,
  params: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(requirement.input ?? {}).map(([key, value]) => [
      key,
      typeof value === 'string' && value.startsWith(':')
        ? (params[value.slice(1)] ?? value)
        : value,
    ]),
  );
}

/** Plugin-owned settings reuse the regular route resolver and its authorization gates. */
export async function getPluginSettingsSections() {
  const candidates = await listPluginFrontendCandidates();
  const locale = await getLocale();
  const sections = [];
  for (const candidate of candidates) {
    const { messages } = readPackageMessages(candidate.id, candidate.manifest.messages);
    for (const route of candidate.manifest.adminRoutes) {
      if (!route.systemSettings || /[:*]/.test(route.path)) continue;
      const href = pluginSettingsHref(candidate.id, route.path);
      const id = href.split('#')[1]!;
      const result = await resolvePluginAdminRoute(candidate.id, route.path, href);
      if (result.status !== 'ok') continue;
      sections.push({
        id,
        title: packageLabel(
          messages,
          locale,
          route.systemSettings.labelKey,
          route.systemSettings.label,
          [DEFAULT_LOCALE],
        ),
        order: route.systemSettings.order ?? 100,
        pluginId: candidate.id,
        path: route.path,
        result,
      });
    }
  }
  return sections.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function pluginSettingsHref(pluginId: string, path: string): string {
  return `/admin/settings#plugin-${pluginId}-${encodeURIComponent(path)}`;
}
