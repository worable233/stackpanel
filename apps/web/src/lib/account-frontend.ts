import 'server-only';
import type {
  AccountPageComponent,
  AccountUser,
  AccountWidgetComponent,
  FinderProvider,
  FrontendActionExecutors,
  FrontendPageDataRequirement,
  FrontendSettings,
} from '@stackpanel/sdk';
import { matchFrontendPagePath } from '@stackpanel/sdk';
import { getAuthedApiClient } from './api';
import { importFrontendPackage, listPluginFrontendCandidates, readPluginSettings } from './slots';
import { bindPluginActions } from './frontend-plugin-actions';

export interface PluginAccountMenu {
  pluginId: string;
  label: string;
  href: string;
  group?: string;
}

export type PluginAccountRouteResult =
  | {
      status: 'ok';
      component: AccountPageComponent;
      pluginId: string;
      settings: FrontendSettings;
      data: Record<string, unknown>;
      params: Record<string, string>;
      actions: FrontendActionExecutors;
    }
  | { status: 'denied'; permission: string }
  | { status: 'not-found' };

export interface PluginAccountWidget {
  id: string;
  pluginId: string;
  title: string;
  component: AccountWidgetComponent;
  settings: FrontendSettings;
}

/** Discover visible signed-in account menus from active plugin frontend packages. */
export async function getPluginAccountMenus(): Promise<PluginAccountMenu[]> {
  const candidates = await listPluginFrontendCandidates();
  const api = await getAuthedApiClient();
  const menus: PluginAccountMenu[] = [];
  for (const candidate of candidates) {
    for (const route of candidate.manifest.accountRoutes) {
      if (!route.nav || !(await isAllowed(api, route.permission))) continue;
      menus.push({
        pluginId: candidate.id,
        label: route.nav.label,
        href: accountHref(route.path),
        ...(route.nav.group ? { group: route.nav.group } : {}),
      });
    }
  }
  return menus;
}

/**
 * Execute a finder contributed by any active plugin frontend package. Used by
 * the platform account overview to surface plugin data (balance, orders, ...)
 * without binding the shell to a specific plugin.
 */
export async function executeAccountFinder(
  finderId: string,
  user: AccountUser,
): Promise<unknown | null> {
  const candidates = await listPluginFrontendCandidates();
  for (const candidate of candidates) {
    const pkg = await importFrontendPackage('plugins', candidate.id, candidate.manifest);
    if (!pkg?.finders || !pkg.finders[finderId]) continue;
    const settings = await readPluginSettings(candidate.id);
    try {
      return await pkg.finders[finderId].handler(
        {},
        {
          params: {},
          settings,
          api: await getAuthedApiClient(),
          session: { role: user.role },
        },
      );
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolve a user-facing plugin account page and its declared finder data. */
export async function resolvePluginAccountRoute(
  path: string,
  user: AccountUser,
): Promise<PluginAccountRouteResult> {
  const candidates = await listPluginFrontendCandidates();
  const matches = candidates.flatMap((candidate) =>
    candidate.manifest.accountRoutes
      .filter((route) => matchFrontendPagePath(route.path, path))
      .map((route) => ({ candidate, route })),
  );
  const matched = pickBestRoute(matches);
  if (!matched) return { status: 'not-found' };

  const { candidate, route } = matched;
  const api = await getAuthedApiClient();
  if (!(await isAllowed(api, route.permission))) {
    return { status: 'denied', permission: route.permission ?? 'account.permission' };
  }
  const pkg = await importFrontendPackage('plugins', candidate.id, candidate.manifest);
  const component = pkg?.ui?.accountPages?.[route.component];
  if (!component) return { status: 'not-found' };

  const settings = await readPluginSettings(candidate.id);
  const params = capturePathParams(route.path, path);
  const data = await executeRouteData(route.data ?? [], pkg.finders ?? {}, params, settings, user);
  try {
    await api.recordFrontendAudit('frontend.account.route.render', candidate.id, path, {
      route: route.path,
    });
  } catch {
    // Observability must not block account access.
  }
  return {
    status: 'ok',
    component,
    pluginId: candidate.id,
    settings,
    data,
    params,
    actions: bindPluginActions(candidate.id, candidate.manifest.actions, `/account${path}`),
  };
}

/** Resolve compact account overview modules from active plugin packages. */
export async function getPluginAccountWidgets(): Promise<PluginAccountWidget[]> {
  const candidates = await listPluginFrontendCandidates();
  const api = await getAuthedApiClient();
  const widgets: PluginAccountWidget[] = [];
  for (const candidate of candidates) {
    const pkg = await importFrontendPackage('plugins', candidate.id, candidate.manifest);
    if (!pkg) continue;
    for (const definition of candidate.manifest.accountWidgets) {
      if (!(await isAllowed(api, definition.permission))) continue;
      const component = pkg.ui?.accountWidgetComponents?.[definition.component];
      if (!component) continue;
      widgets.push({
        id: definition.id,
        pluginId: candidate.id,
        title: definition.title,
        component,
        settings: await readPluginSettings(candidate.id),
      });
    }
  }
  return widgets;
}

function accountHref(routePath: string): string {
  return routePath === '/' ? '/account' : `/account${routePath}`;
}

async function isAllowed(
  api: Awaited<ReturnType<typeof getAuthedApiClient>>,
  permission: string | undefined,
): Promise<boolean> {
  if (!permission) return true;
  try {
    return (await api.checkPermission(permission)).allowed;
  } catch {
    return false;
  }
}

async function executeRouteData(
  requirements: FrontendPageDataRequirement[],
  finders: Record<string, FinderProvider>,
  params: Record<string, string>,
  settings: FrontendSettings,
  user: AccountUser,
): Promise<Record<string, unknown>> {
  const api = await getAuthedApiClient();
  const values = await Promise.all(
    requirements.map(async (requirement) => {
      if (!(await isAllowed(api, requirement.permission))) return null;
      const finder = finders[requirement.finder];
      if (!finder) return null;
      try {
        return [
          requirement.as,
          await finder.handler(resolveFinderInput(requirement, params), {
            params,
            settings,
            api,
            session: { role: user.role },
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

function capturePathParams(pattern: string, path: string): Record<string, string> {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = path.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  patternSegments.forEach((segment, index) => {
    if (segment.startsWith(':')) params[segment.slice(1)] = pathSegments[index] ?? '';
  });
  return params;
}

/** Prefer a literal route over a `:param`/wildcard match for the same request path. */
function pickBestRoute<T extends { route: { path: string } }>(matches: T[]): T | null {
  if (matches.length === 0) return null;
  const literal = matches.find(
    (entry) => !entry.route.path.includes(':') && entry.route.path !== '*',
  );
  if (literal) return literal;
  if (matches.length === 1) return matches[0];
  const param = matches.find((entry) => entry.route.path.includes(':'));
  return param ?? matches[0];
}
