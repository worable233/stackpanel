import 'server-only';
import type { FrontendSettings } from '@stackpanel/sdk';
import type {
  FinderProvider,
  FrontendActionExecutors,
  FrontendPageDataRequirement,
} from '@stackpanel/sdk';
import { matchFrontendPagePath } from '@stackpanel/sdk';
import { getAuthedApiClient } from './api';
import { importFrontendPackage, listPluginFrontendCandidates, readPluginSettings } from './slots';
import { bindPluginActions } from './frontend-plugin-actions';

export interface PluginAdminMenu {
  pluginId: string;
  label: string;
  href: string;
  group?: string;
}

export type PluginAdminRouteResult =
  | {
      status: 'ok';
      pluginId: string;
      componentId: string;
      settings: FrontendSettings;
      data: Record<string, unknown>;
      actions: FrontendActionExecutors;
      params: Record<string, string>;
    }
  | { status: 'denied'; permission: string }
  | { status: 'not-found' };

/** Admin sidebar menus contributed by active plugin frontend packages. */
export async function getPluginAdminMenus(): Promise<PluginAdminMenu[]> {
  const candidates = await listPluginFrontendCandidates();
  const menus: PluginAdminMenu[] = [];
  for (const candidate of candidates) {
    for (const route of candidate.manifest.adminRoutes) {
      if (!route.nav) continue;
      menus.push({
        pluginId: candidate.id,
        label: route.nav.label,
        href: pluginAdminHref(candidate.id, route.path),
        ...(route.nav.group ? { group: route.nav.group } : {}),
      });
    }
  }
  return menus;
}

/** Resolve a plugin admin route and enforce its declared permission. */
export async function resolvePluginAdminRoute(
  pluginId: string,
  path: string,
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
  const pkg = await importFrontendPackage('plugins', pluginId, candidate.manifest);
  if (!pkg) return { status: 'not-found' };
  // 合并所有已加载插件的前端 finders，使 admin 页面可跨插件复用数据提供者
  // （例如 store 的商品管理页读取 catalog 的分类数据）。
  const mergedFinders: Record<string, FinderProvider> = {};
  for (const item of candidates) {
    const candidatePkg = await importFrontendPackage('plugins', item.id, item.manifest);
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
    pluginId,
    componentId: route.component,
    settings,
    data: await executeRouteData(route.data ?? [], mergedFinders, params, settings),
    actions: bindPluginActions(
      pluginId,
      candidate.manifest.actions,
      `/admin/plugin/${pluginId}${path}`,
    ),
    params,
  };
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
