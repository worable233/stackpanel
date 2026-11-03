import 'server-only';
import { cache } from 'react';
import type { FrontendSettings } from '@stackpanel/sdk';
import type {
  FrontendActionExecutors,
  FrontendManifest,
} from '@stackpanel/sdk';
import { ApiError, matchFrontendPagePath } from '@stackpanel/sdk';
import { getAuthedApiClient } from './api';
import {
  importFrontendPackage,
  mergedPluginFinders,
  listPluginFrontendCandidates,
  readPluginSettings,
} from './slots';
import { runtimeAdminModuleUrl, runtimeFrontendFailure, runtimeFrontendLoadingEnabled } from './frontend-runtime';
import { getLocale } from '@/i18n/locale';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { packageLabel, readPackageMessages } from '@/i18n/package-messages';
import { bindPluginActions } from './frontend-plugin-actions';
import { executePageData } from './frontend-page-data';
import { requestPermission } from './shell-request-cache';

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
      /** 数据需求的真失败；缺席表示全部成功（见 AdminPageComponentProps）。 */
      dataErrors?: Array<{ as: string; code?: string; requestId?: string }>;
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
  /** 包加载失败（原因见 `runtimeFrontendFailure`），与「没有这个页面」区分开。 */
  | { status: 'broken'; pluginId: string; reason: string }
  | { status: 'not-found' };

/** Admin sidebar menus contributed by active plugin frontend packages. */
export const getPluginAdminMenus = cache(async (): Promise<PluginAdminMenu[]> => {
  const candidates = await listPluginFrontendCandidates();
  const menus: PluginAdminMenu[] = [];
  const locale = await getLocale();
  for (const candidate of candidates) {
    const { messages } = readPackageMessages(candidate.id, candidate.manifest.messages);
    for (const route of candidate.manifest.adminRoutes) {
      if (
        route.systemSettings ||
        !route.nav ||
        (route.permission && !(await isAllowed(route.permission)))
      )
        continue;
      // Labels are resolved through the package's own catalog (ADR-0016 §5).
      // The literal `label` stays the fallback for locales the package omits.
      const group = packageLabel(messages, locale, route.nav.groupKey, route.nav.group, [
        DEFAULT_LOCALE,
      ]);
      menus.push({
        pluginId: candidate.id,
        label: packageLabel(messages, locale, route.nav.labelKey, route.nav.label, [
          DEFAULT_LOCALE,
        ]),
        href: pluginAdminHref(candidate.id, route.path),
        order: route.nav.order,
        activePaths: route.nav.activePaths?.map((path) => pluginAdminHref(candidate.id, path)),
        ...(group ? { group } : {}),
      });
    }
  }
  return menus;
});

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
  const api = await getAuthedApiClient();
  if (route.permission) {
    if (!(await requestPermission(route.permission))) return { status: 'denied', permission: route.permission };
  }
  const pkg = await importFrontendPackage(
    'plugins',
    pluginId,
    candidate.manifest,
    candidate.revision,
  );
  if (!pkg) {
    // 与账号页同理：加载崩溃不能伪装成 404（v0.1.1 插件页全部「未找到」的根因）。
    const reason = runtimeFrontendFailure('plugins', pluginId, candidate.revision);
    if (reason) return { status: 'broken', pluginId, reason };
    return { status: 'not-found' };
  }
  /**
   * 合并 finders 走请求级缓存（见 `mergedPluginFinders`）。
   *
   * admin 页面同样要跨插件复用数据提供者（store 的商品管理页读 catalog 的
   * 分类）。原先这里自己再遍历一遍全部插件、逐个 import 包 —— 与 finders
   * 解析、菜单构建各扫一次，一个后台页面要重复装载好几次全部插件前端。
   */
  const mergedFinders = await mergedPluginFinders();
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
    // 与 pages.ts 一致：真失败收集成 `dataErrors`，让插件页面能区分
    // “真的没有数据”和“读失败了”——否则页面只能 `?? []`，把报错渲染成空态。
    ...(await (async () => {
      const dataErrors: Array<{ as: string; code?: string; requestId?: string }> = [];
      const data = await executePageData(route.data ?? [], {
        finders: mergedFinders,
        params,
        settings,
        session: { role: 'ADMIN' },
        api,
        isAllowed: (permission) => isAllowed(permission),
        onFailure: (failure) => {
          const error = failure.error;
          const code = error instanceof ApiError ? error.code : undefined;
          const requestId = error instanceof ApiError ? error.requestId : undefined;
          dataErrors.push({
            as: failure.as,
            ...(code ? { code } : {}),
            ...(requestId ? { requestId } : {}),
          });
          if (error instanceof Error) {
            // i18n-exempt: server-side diagnostic log, never rendered to a user.
        console.error(`[page-data] ${failure.as} failed: ${error.message}`);
          }
        },
      });
      return { data, ...(dataErrors.length > 0 ? { dataErrors } : {}) };
    })()),
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


async function isAllowed(permission: string): Promise<boolean> {
  try {
    return await requestPermission(permission);
  } catch {
    return false;
  }
}


/** Plugin-owned settings reuse the regular route resolver and its authorization gates. */
export const getPluginSettingsSections = cache(async () => {
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
});

function pluginSettingsHref(pluginId: string, path: string): string {
  return `/admin/settings#plugin-${pluginId}-${encodeURIComponent(path)}`;
}
