import 'server-only';

import type {
  FinderProvider,
  FrontendManifest,
  FrontendPackage,
  FrontendSettings,
} from '@stackpanel/sdk';
import { getApiClient, apiAssetUrl } from './api';
import { frontendSnapshot, pinInSnapshot } from './frontend-snapshot';
import { getFrontendPackage } from './frontend-bundles';
import { loadRuntimeFrontend, runtimeFrontendLoadingEnabled } from './frontend-runtime';
import { cacheKey, invalidate, remember } from './server-cache';
import { cache } from 'react';
import { requestActiveTheme, requestThemeFrontend } from './platform-request-cache';

export interface FrontendCandidate {
  kind: 'themes' | 'plugins';
  id: string;
  manifest: FrontendManifest;
  /**
   * Kernel-computed admission for server-side execution in the web process
   * (contract 03 §3.1). Themes ship with the image and are always admitted;
   * plugin candidates carry the kernel's decision. Absent (older API) is
   * treated as `declarative` so the gate is fail-closed.
   */
  serverExecution?: 'allowed' | 'declarative';
  /**
   * Active content-addressed revision (contract 04 §1), when the kernel exposes
   * it. Used to build versioned same-origin asset URLs so a request pins one
   * deployment version.
   */
  revision?: string;
}

export async function activeThemeCandidate(): Promise<FrontendCandidate | null> {
  // Contract 04 §3: resolve the active revision once per request, so every
  // consumer of a render (pages, layout, SEO, actions) sees one deployment.
  return pinInSnapshot('theme', () => resolveActiveThemeCandidate());
}

async function resolveActiveThemeCandidate(): Promise<FrontendCandidate | null> {
  try {
    // /themes/active 线上 1111 次、p50 136ms。
    //
    // 走请求级缓存（`requestActiveTheme`）而不是另开一层进程级 TTL：
    // `theme-stylesheet.tsx` 和 `frontend-stylesheets.tsx` 也要读同一个主题，
    // 两套缓存各存一份的结果就是「同一请求仍然打两次内核」。统一到请求级后，
    // 一次渲染只读一次，且切主题立刻生效（不用等 TTL）。
    const { theme } = await requestActiveTheme();
    if (!theme) return null;
    // 同样统一到请求级：`frontend-stylesheets.tsx` 也要读这份描述。
    const manifest = await requestThemeFrontend(theme.id);
    if (!manifest?.available || !manifest.manifest) return null;
    return {
      kind: 'themes',
      id: theme.id,
      manifest: manifest.manifest,
      ...(manifest.revision ? { revision: manifest.revision } : {}),
    };
  } catch {
    return null;
  }
}

/** Load a specific installed theme frontend candidate for preview rendering. */
export async function themeFrontendCandidate(themeId: string): Promise<FrontendCandidate | null> {
  // Preview pins an explicit theme. It shares the snapshot only when it is the
  // active theme; otherwise it resolves independently (previews are not the
  // deployment the rest of the request renders against).
  return resolveThemeCandidate(themeId);
}

async function resolveThemeCandidate(themeId: string): Promise<FrontendCandidate | null> {
  try {
    const descriptor = await getApiClient().getThemeFrontend(themeId);
    if (!descriptor.available || !descriptor.manifest) return null;
    return {
      kind: 'themes',
      id: themeId,
      manifest: descriptor.manifest,
      ...(descriptor.revision ? { revision: descriptor.revision } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Discover every active plugin that contributes a compiled frontend package.
 *
 * 用 React `cache()` 而不是 `pinInSnapshot`：实测 `AsyncLocalStorage` 的
 * `enterWith` 作用域**不跨渲染阶段**（layout 与 page、`generateMetadata` 与
 * 页面组件之间都不共享），于是同一请求里菜单构建、路由解析、widgets 各建
 * 一份快照，`/plugins/frontends` 被打多次。`cache()` 由 Next 绑定到同一次
 * 渲染，跨这些阶段共享。
 *
 * 同时保留进程级 5s 缓存（`remember`），省掉跨请求的那一跳。
 */
export const listPluginFrontendCandidates = cache(
  async (): Promise<FrontendCandidate[]> => resolvePluginFrontendCandidates(),
);

/** 插件清单缓存的作用域前缀（供 `invalidate` 使用）。 */
export const PLUGIN_FRONTENDS_CACHE = 'plugin-frontends';

/**
 * 把 `/plugins/frontends` 的结果在进程内复用一段短时间。
 *
 * 请求内已经有 `pinInSnapshot` 去重，但**跨请求**没有：每个页面渲染仍会打
 * 一次内核。现场该端点 p95 8892ms / max 10025ms（每次要对 23 个插件做全量
 * 文件系统扫描），而它又是所有页面的公共依赖 —— 一次抖动会同时拖慢所有
 * 正在渲染的页面。
 *
 * 内核侧已经给该端点加了代际缓存，这里是第二层：省掉 web → api 的这一跳。
 * TTL 取 5s：比内核的 30s 短，插件启停最多延迟 5s 反映到前端，换掉的是每条
 * 请求都要等的那一跳。
 */
export function invalidatePluginFrontends(): void {
  invalidate(PLUGIN_FRONTENDS_CACHE);
}

async function resolvePluginFrontendCandidates(): Promise<FrontendCandidate[]> {
  try {
    const { plugins } = await remember(
      cacheKey(PLUGIN_FRONTENDS_CACHE),
      () => getApiClient().getPluginFrontends(),
      { ttlMs: 5_000 },
    );
    return plugins
      .filter((plugin) => plugin.manifest)
      .map((plugin) => ({
        kind: 'plugins' as const,
        id: plugin.id,
        manifest: plugin.manifest!,
        serverExecution: plugin.serverExecution,
        ...(plugin.revision ? { revision: plugin.revision } : {}),
      }));
  } catch {
    return [];
  }
}

/**
 * Versioned same-origin base URL for a candidate's compiled assets
 * (contract 04 §2). Falls back to the unversioned base when the kernel has not
 * published a revision, so older deployments keep working.
 */
export function candidateAssetBase(candidate: FrontendCandidate): string {
  return candidate.revision
    ? apiAssetUrl(`/${candidate.kind}/${candidate.id}/frontend/${candidate.revision}`)
    : apiAssetUrl(`/${candidate.kind}/${candidate.id}/frontend`);
}

/**
 * Whether the server-execution trust gate is active (contract 03 §3.1).
 *
 * Default ON: third-party packages do **not** execute in the web process unless
 * the kernel admits them (`builtin` or the operator allowlist). Set
 * `STACKPANEL_FRONTEND_TRUST_GATE=0` to disable the gate (legacy behaviour: every
 * installed package may execute). The opt-out exists so a deployment can roll
 * back without a code change if a legitimate package is mis-classified.
 */
export function serverExecutionGateEnabled(): boolean {
  return process.env.STACKPANEL_FRONTEND_TRUST_GATE !== '0';
}

/**
 * Whether a candidate may execute server-side code (finders) in the web
 * process. Themes ship with the image and are always admitted; plugin
 * candidates use the kernel's `serverExecution` decision. Fail-closed: an
 * absent decision (older API) is treated as not admitted when the gate is on.
 */
export function candidateAdmitsServerExecution(candidate: FrontendCandidate): boolean {
  if (candidate.kind === 'themes') return true;
  if (!serverExecutionGateEnabled()) return true;
  return candidate.serverExecution === 'allowed';
}

export async function readThemeSettings(id: string): Promise<FrontendSettings> {
  try {
    return (await getApiClient().getThemeSettings(id)).settings;
  } catch {
    return {};
  }
}

/**
 * 读插件设置，按请求去重。
 *
 * 同一请求里它会被读很多次：resolvePluginAdminRoute 自己要读，
 * mergedPluginFinders 的每个 finder 又要读一次，账号组件/后台菜单也各读一次。
 * 而设置在一次渲染里不会变 —— 重复读只是重复打内核。
 */
export const readPluginSettings = cache(async (id: string): Promise<FrontendSettings> => {
  try {
    return (await getApiClient().getPluginSettings(id)).settings;
  } catch {
    return {};
  }
});

/**
 * Import a compiled frontend package.
 *
 * Two co-existing paths (stage 5 makes runtime loading the **default**):
 *
 * - **Runtime loading** (default; `STACKPANEL_FRONTEND_RUNTIME_LOAD=0` opts out): the
 *   host loads the package's compiled entry from the `data/` revision store at request
 *   time, so installing a theme/plugin no longer requires a `next build`. Host ABI is
 *   shared through the synchronous resolve hook (see `frontend-runtime.ts`).
 * - **Build-time registry** (`STACKPANEL_FRONTEND_RUNTIME_LOAD=0`): every package is
 *   statically imported into the generated registry so Next bundles them at build time.
 *   This is the reversible fallback; regenerate it with
 *   `STACKPANEL_FRONTEND_RUNTIME_LOAD=0 pnpm build:frontend`.
 *
 * In both cases the resolved value is validated against the manifest so a stale or
 * partial artifact is treated as "no package" rather than crashing a render.
 */
/**
 * 合并所有「允许在 web 进程执行」的插件 finders（`name → provider`）。
 *
 * 结果按请求缓存：同一个渲染里多个数据需求共用一次扫描。
 *
 * 为什么必须合并去重：原先每个 finder 需求各自遍历全部插件候选、逐个
 * `import()` 前端包、逐个读插件设置。`/account` 首页一次要 4 个 finder，
 * 于是同一个全量扫描做了 4 遍 —— 插件数量直接乘在首屏耗时上。
 */
export async function mergedPluginFinders(): Promise<Record<string, FinderProvider>> {
  return (await finderRegistry()).finders;
}

/**
 * finder 名 → 提供它的插件 id。设置必须取自**提供者**，用错插件的设置会让
 * finder 读到别人的配置（例如把 ticket 的开关当成 store 的）。
 */
export async function finderOwnerPlugin(finderId: string): Promise<string | null> {
  return (await finderRegistry()).owners[finderId] ?? null;
}

/**
 * 一次扫描得到「合并 finders + 归属插件」。
 *
 * 两者必须同源：分开各扫一遍就等于没优化。结果按请求缓存在快照上。
 */
async function finderRegistry(): Promise<{
  finders: Record<string, FinderProvider>;
  owners: Record<string, string>;
}> {
  const snapshot = frontendSnapshot();
  const cached = snapshot.finders;
  if (cached) return cached;
  const pending = (async () => {
    const candidates = await listPluginFrontendCandidates();
    const finders: Record<string, FinderProvider> = {};
    const owners: Record<string, string> = {};
    for (const candidate of candidates) {
      // Trust boundary (contract 03 §3.1): 未获准入的包不得在 web 进程执行。
      if (!candidateAdmitsServerExecution(candidate)) continue;
      const pkg = await importFrontendPackage(
        'plugins',
        candidate.id,
        candidate.manifest,
        candidate.revision,
      );
      if (!pkg?.finders) continue;
      for (const [name, finder] of Object.entries(pkg.finders)) {
        // 先到先得：与原先「遍历顺序第一个胜出」的语义保持一致。
        if (!finders[name]) {
          finders[name] = finder;
          owners[name] = candidate.id;
        }
      }
    }
    return { finders, owners };
  })();
  snapshot.finders = pending;
  pending.catch(() => {
    if (snapshot.finders === pending) delete snapshot.finders;
  });
  return pending;
}

export async function importFrontendPackage(
  kind: 'themes' | 'plugins',
  id: string,
  manifest: FrontendManifest,
  revision?: string,
): Promise<FrontendPackage | null> {
  if (runtimeFrontendLoadingEnabled()) {
    const loaded = await loadRuntimeFrontend(kind, id, revision);
    if (loaded && isFrontendPackage(loaded, manifest)) return loaded as FrontendPackage;
  }
  const pkg = getFrontendPackage(kind, id);
  if (!pkg || !isFrontendPackage(pkg, manifest)) return null;
  return pkg;
}

function isFrontendPackage(value: unknown, manifest: FrontendManifest): value is FrontendPackage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (manifest.pages.length > 0 && !isRecord(candidate['pageComponents'])) return false;
  if (manifest.layouts.length > 0 && !isRecord(candidate['layouts'])) return false;
  if (manifest.finders.length > 0 && !isRecord(candidate['finders'])) return false;
  const hasUiSurface =
    manifest.adminRoutes.length > 0 ||
    manifest.adminActions.length > 0 ||
    manifest.actions.length > 0 ||
    manifest.accountRoutes.length > 0 ||
    manifest.accountWidgets.length > 0;
  return !hasUiSurface || isRecord(candidate['ui']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
