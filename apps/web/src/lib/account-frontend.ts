import 'server-only';
import type {
  AccountPageComponent,
  AccountUser,
  AccountWidgetComponent,
  FrontendActionExecutors,
  FrontendSettings,
} from '@stackpanel/sdk';
import { matchFrontendPagePath } from '@stackpanel/sdk';
import { getAuthedApiClient } from './api';
import {
  candidateAdmitsServerExecution,
  importFrontendPackage,
  listPluginFrontendCandidates,
  readPluginSettings,
} from './slots';
import { bindPluginActions } from './frontend-plugin-actions';
import { executePageData } from './frontend-page-data';
import { getLocale } from '@/i18n/locale';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { packageLabel, readPackageMessages } from '@/i18n/package-messages';

export interface PluginAccountMenu {
  pluginId: string;
  label: string;
  href: string;
  group?: string;
  order?: number;
  activePaths?: string[];
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
  const locale = await getLocale();
  const menus: PluginAccountMenu[] = [];
  for (const candidate of candidates) {
    const { messages } = readPackageMessages(candidate.id, candidate.manifest.messages);
    for (const route of candidate.manifest.accountRoutes) {
      if (!route.nav || !(await isAllowed(api, route.permission))) continue;
      const group = packageLabel(messages, locale, route.nav.groupKey, route.nav.group, [
        DEFAULT_LOCALE,
      ]);
      menus.push({
        pluginId: candidate.id,
        label: packageLabel(messages, locale, route.nav.labelKey, route.nav.label, [
          DEFAULT_LOCALE,
        ]),
        href: accountHref(route.path),
        order: route.nav.order,
        activePaths: route.nav.activePaths?.map(accountHref),
        ...(group ? { group } : {}),
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
    if (!candidateAdmitsServerExecution(candidate)) continue;
    const pkg = await importFrontendPackage(
      'plugins',
      candidate.id,
      candidate.manifest,
      candidate.revision,
    );
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
  searchParams: Record<string, string> = {},
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
  const pkg = await importFrontendPackage(
    'plugins',
    candidate.id,
    candidate.manifest,
    candidate.revision,
  );
  const component = pkg?.ui?.accountPages?.[route.component];
  if (!component) return { status: 'not-found' };

  const settings = await readPluginSettings(candidate.id);
  const params = capturePathParams(route.path, path);
  // Trust boundary (contract 03 §3.1): an unauthorized package's finders must
  // not execute in the web process.
  const finders = candidateAdmitsServerExecution(candidate) ? (pkg.finders ?? {}) : {};
  const data = await executePageData(route.data ?? [], {
    finders,
    params,
    searchParams,
    settings,
    session: { role: user.role },
    api,
    isAllowed: (permission) => isAllowed(api, permission),
  });
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
    actions: bindPluginActions(
      candidate.id,
      candidate.manifest.actions,
      `/account${path}${Object.keys(searchParams).some((key) => key !== 'error') ? `?${new URLSearchParams(Object.entries(searchParams).filter(([key]) => key !== 'error')).toString()}` : ''}`,
    ),
  };
}

/** Resolve compact account overview modules from active plugin packages. */
export async function getPluginAccountWidgets(): Promise<PluginAccountWidget[]> {
  const candidates = await listPluginFrontendCandidates();
  const api = await getAuthedApiClient();
  const locale = await getLocale();
  const widgets: PluginAccountWidget[] = [];
  for (const candidate of candidates) {
    if (!candidateAdmitsServerExecution(candidate)) continue;
    const pkg = await importFrontendPackage(
      'plugins',
      candidate.id,
      candidate.manifest,
      candidate.revision,
    );
    if (!pkg) continue;
    const { messages } = readPackageMessages(candidate.id, candidate.manifest.messages);
    for (const definition of candidate.manifest.accountWidgets) {
      if (!(await isAllowed(api, definition.permission))) continue;
      const component = pkg.ui?.accountWidgetComponents?.[definition.component];
      if (!component) continue;
      widgets.push({
        id: definition.id,
        pluginId: candidate.id,
        title: packageLabel(messages, locale, definition.titleKey, definition.title, [
          DEFAULT_LOCALE,
        ]),
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
