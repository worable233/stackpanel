import 'server-only';
import { cache } from 'react';
import type {
  AccountPageComponent,
  AccountUser,
  AccountWidgetComponent,
  FrontendActionExecutors,
  FrontendSettings,
} from '@stackpanel/sdk';
import { matchFrontendPagePath } from '@stackpanel/sdk';
import { getAuthedApiClient } from './api';
import { runtimeFrontendFailure } from './frontend-runtime';
import {
  candidateAdmitsServerExecution,
  finderOwnerPlugin as finderOwner,
  importFrontendPackage,
  mergedPluginFinders,
  listPluginFrontendCandidates,
  readPluginSettings,
} from './slots';
import { bindPluginActions } from './frontend-plugin-actions';
import { executePageData } from './frontend-page-data';
import { getLocale } from '@/i18n/locale';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { packageLabel, readPackageMessages } from '@/i18n/package-messages';
import { requestPermission } from './shell-request-cache';

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
  /**
   * 包**加载失败**（不是没有这个页面）。
   *
   * 与 `not-found` 必须分开：加载崩溃时以前一律报 404，运维看到的是「未找到这个
   * 账户页面」，而真实原因是服务端 import 抛错（v0.1.1 线上 `/account/referral`
   * 连续 57 次同一条报错的根源）。混在一起就无法从界面定位问题。
   */
  | { status: 'broken'; pluginId: string; reason: string }
  | { status: 'not-found' };

export interface PluginAccountWidget {
  id: string;
  pluginId: string;
  title: string;
  component: AccountWidgetComponent;
  settings: FrontendSettings;
}

/** Discover visible signed-in account menus from active plugin frontend packages. */
export const getPluginAccountMenus = cache(async (): Promise<PluginAccountMenu[]> => {
  const candidates = await listPluginFrontendCandidates();
  const locale = await getLocale();
  const menus: PluginAccountMenu[] = [];
  for (const candidate of candidates) {
    const { messages } = readPackageMessages(candidate.id, candidate.manifest.messages);
    for (const route of candidate.manifest.accountRoutes) {
      if (!route.nav || !(await isAllowed(route.permission))) continue;
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
});

/**
 * Execute a finder contributed by any active plugin frontend package. Used by
 * the platform account overview to surface plugin data (balance, orders, ...)
 * without binding the shell to a specific plugin.
 */
export async function executeAccountFinder(
  finderId: string,
  user: AccountUser,
): Promise<unknown | null> {
  /**
   * 用按请求合并的 finders 表，而不是每次重新遍历插件。
   *
   * 原先每个 finder 都完整走一遍「列出候选 → 逐个 import 包 → 逐个读设置」。
   * `/account` 首页一次要 4 个 finder（待付订单、我的服务、工单、身份绑定），
   * 于是同一个全量扫描重复 4 次 —— 这就是该页慢的主因之一。
   */
  const finders = await mergedPluginFinders();
  const finder = finders[finderId];
  if (!finder) return null;
  const owner = await finderOwner(finderId);
  try {
    return await finder.handler(
      {},
      {
        params: {},
        settings: owner ? await readPluginSettings(owner) : {},
        api: await getAuthedApiClient(),
        session: { role: user.role },
      },
    );
  } catch {
    return null;
  }
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
  if (!(await isAllowed(route.permission))) {
    return { status: 'denied', permission: route.permission ?? 'account.permission' };
  }
  const pkg = await importFrontendPackage(
    'plugins',
    candidate.id,
    candidate.manifest,
    candidate.revision,
  );
  if (!pkg) {
    // 区分「包没加载起来」与「包里没有这个页面」：前者是可诊断的故障，后者是
    // 真的 404。只报 not-found 会让加载崩溃伪装成「页面不存在」。
    const reason = runtimeFrontendFailure('plugins', candidate.id, candidate.revision);
    if (reason) return { status: 'broken', pluginId: candidate.id, reason };
    return { status: 'not-found' };
  }
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
    isAllowed: (permission) => isAllowed(permission),
  });
  // 审计不阻塞渲染（同 admin 侧与 pages.ts）：写失败只丢一条观测。
  void api
    .recordFrontendAudit('frontend.account.route.render', candidate.id, path, {
      route: route.path,
    })
    .catch(() => undefined);
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
export const getPluginAccountWidgets = cache(async (): Promise<PluginAccountWidget[]> => {
  const candidates = await listPluginFrontendCandidates();
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
      if (!(await isAllowed(definition.permission))) continue;
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
});

function accountHref(routePath: string): string {
  return routePath === '/' ? '/account' : `/account${routePath}`;
}

async function isAllowed(permission: string | undefined): Promise<boolean> {
  if (!permission) return true;
  try {
    return await requestPermission(permission);
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
