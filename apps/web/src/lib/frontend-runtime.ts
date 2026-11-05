// @i18n-exempt — server-side runtime diagnostics (developer log messages, not UI copy)
import 'server-only';

import path from 'node:path';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { apiAssetUrl } from './api';
import { publishHostServerAbi } from './frontend-host-abi';
import { ensureFrontendLoaderHooks } from './frontend-loader';

/**
 * 运行时装载前端（PLAN-runtime-frontend-loading §5 阶段 4）。
 *
 * 把「装一个主题/插件必须重跑 `next build`」这条约束拿掉：宿主在运行期从 `data/`
 * 目录动态 `import()` 已编译的前端入口，而不是在构建期把它们静态 import 进 Next 的
 * 服务端 bundle。
 *
 * 关键前提（见 SPIKE-results §0）：
 * 1. `publishHostServerAbi()` 必须**先**运行，把宿主 RSC ABI（客户端引用代理）发布
 *    到 `globalThis`；
 * 2. `ensureFrontendLoaderHooks()` 注册同步 resolve 钩子，把运行期模块的宿主 ABI
 *    说明符重定向到上述代理；
 * 3. `import()` 用 `turbopackIgnore`/`webpackIgnore` 保持为真正的 Node ESM 运行期
 *    导入（否则 Turbopack 会尝试在构建期解析它）。
 *
 * revision（契约 04）：装载路径优先指向不可变的 revision 目录
 * `frontend/revisions/<rev>/dist/index.js`。内容摘要变化 = 新路径 = 新模块，天然
 * 规避 Node ESM 缓存无法卸载的问题；无 revision 时回退到平坦 `frontend/dist/`。
 */

const g = globalThis as unknown as {
  __STACKPANEL_RUNTIME_MODULES__?: Map<string, Promise<unknown>>;
  __STACKPANEL_RUNTIME_FAILURES__?: Map<string, { message: string; at: number }>;
};

function moduleCache(): Map<string, Promise<unknown>> {
  if (!g.__STACKPANEL_RUNTIME_MODULES__) g.__STACKPANEL_RUNTIME_MODULES__ = new Map();
  return g.__STACKPANEL_RUNTIME_MODULES__;
}

/**
 * 装载失败的原因，按入口 URL 记最近一次。
 *
 * 调用方（`account-frontend` / `admin-frontend` / `pages`）此前只拿到 `null`，无法
 * 区分「这个包没有该页面」和「这个包加载崩了」，于是把后者也报成 404。这里留下
 * 失败原因，让调用方渲染一个可诊断的错误卡而不是「页面不存在」。
 */
function failureCache(): Map<string, { message: string; at: number }> {
  if (!g.__STACKPANEL_RUNTIME_FAILURES__) g.__STACKPANEL_RUNTIME_FAILURES__ = new Map();
  return g.__STACKPANEL_RUNTIME_FAILURES__;
}

/**
 * 装载失败后的冷却期：期间不再重试，直接按失败处理。
 *
 * 一个坏包会让**每一次渲染**都重新 import 一次（Node ESM 对失败结果不做缓存），
 * 每次都要跑完整条模块解析 + 依赖图链接。线上表现为页面一直转圈，同时把内存和
 * CPU 推高（v0.1.1 的 57 次重复报错就是这么来的）。冷却期内的渲染直接走错误卡。
 */
export const FRONTEND_LOAD_FAILURE_COOLDOWN_MS = 60_000;

/** 最近一次装载失败的原因（未过冷却期才有值）。 */
export function runtimeFrontendFailure(
  kind: 'themes' | 'plugins',
  id: string,
  revision?: string,
  now: number = Date.now(),
): string | null {
  const entry = runtimeFrontendEntry(kind, id, revision);
  if (!entry) return null;
  const failure = failureCache().get(entry);
  if (!failure) return null;
  if (now - failure.at > FRONTEND_LOAD_FAILURE_COOLDOWN_MS) {
    failureCache().delete(entry);
    return null;
  }
  return failure.message;
}

/**
 * 把装载失败写成共享目录下的状态文件（P1-A），供 api 进程展示。
 *
 * 完全不能让它影响渲染：写盘失败只能是「展示少一条」，
 * 不能反过来把本来已经出错的页面弄挂。
 */
export function recordFrontendLoadFailure(
  kind: 'themes' | 'plugins',
  id: string,
  message: string,
): void {
  try {
    const dir = path.join(resolveStackPanelDataDir(), 'runtime-frontend-status');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${kind}-${id}.json`);
    writeFileSync(
      file,
      JSON.stringify({ kind, id, message, at: Date.now() }, null, 2),
      'utf8',
    );
  } catch {
    // 最好努力。
  }
}

/** 测试用：清空失败记录。 */
export function resetRuntimeFrontendFailures(): void {
  failureCache().clear();
}

/** 已编译入口在磁盘上的绝对路径（优先版本化 revision 目录）。 */
export function runtimeFrontendEntry(
  kind: 'themes' | 'plugins',
  id: string,
  revision?: string,
): string | null {
  const packageDir = path.join(resolveStackPanelDataDir(), kind, id);
  if (revision) {
    const versioned = path.join(packageDir, 'frontend', 'revisions', revision, 'dist', 'index.js');
    if (existsSync(versioned)) return versioned;
  }
  const flat = path.join(packageDir, 'frontend', 'dist', 'index.js');
  return existsSync(flat) ? flat : null;
}

/**
 * 运行期装载一个前端包的服务端入口。返回模块导出的 `default`（或命名空间本身，
 * 兼容未默认导出的包）；加载失败返回 `null`，由调用方回退/降级。
 *
 * 结果按**入口绝对路径**缓存（同一 revision 只装载一次）。
 */
export async function loadRuntimeFrontend(
  kind: 'themes' | 'plugins',
  id: string,
  revision?: string,
): Promise<unknown | null> {
  // 发布宿主 ABI + 注册钩子必须在任何 import() 之前。旧 Node（无
  // `module.registerHooks`）下钩子注册失败：不抛出，直接返回 null，由调用方
  // 回退到构建期 registry（默认路径，见下）。
  try {
    publishHostServerAbi();
    ensureFrontendLoaderHooks();
  } catch {
    return null;
  }

  // 契约 04 §9：无共享卷的副本可能还没物化该 revision。装载前显式本地物化
  // （内核镜像在对象存储 / 自身磁盘，经公开资源路由取回）；失败则继续走平坦
  // 回退，绝不把不完整目录当成可装载。
  if (revision && !runtimeFrontendEntry(kind, id, revision)) {
    try {
      const { ensureLocalRevision } = await import('./frontend-localize');
      await ensureLocalRevision(kind, id, revision);
    } catch {
      // 物化失败：交给下面的平坦回退。
    }
  }

  const entry = runtimeFrontendEntry(kind, id, revision);
  if (!entry) return null;

  // Versioned revisions already get a fresh path per content change. The flat
  // fallback (`frontend/dist/index.js`, used when a package has no revision,
  // e.g. entries above the size cap) is overwritten in place, so key the module
  // URL by the file's mtime+size too: an in-place update yields a new URL and a
  // fresh module instance, while an unchanged file keeps its cache entry.
  let freshness = '';
  try {
    const stat = statSync(entry);
    freshness = `${stat.mtimeMs}-${stat.size}`;
  } catch {
    return null;
  }
  const url = `${pathToFileURL(entry).href}?v=${freshness}`;

  const cache = moduleCache();
  // 冷却期内不重试：坏包每次渲染都重新链接一遍依赖图，是线上重复报错与内存
  // 压力的直接来源（见 `FRONTEND_LOAD_FAILURE_COOLDOWN_MS`）。
  const recent = failureCache().get(entry);
  if (recent && Date.now() - recent.at <= FRONTEND_LOAD_FAILURE_COOLDOWN_MS) {
    console.error(
      `[frontend-runtime] ${kind}/${id} 装载失败冷却中（${Math.round(
        (Date.now() - recent.at) / 1000,
      )}s 前）：${recent.message}`,
    );
    return null;
  }

  let pending = cache.get(url);
  if (!pending) {
    pending = import(/* turbopackIgnore: true */ /* webpackIgnore: true */ url).catch((error) => {
      // 模块实例缓存按内容摘要 keyed，失败结果本身不缓存（一次瞬时失败不应永久
      // 毒化后续请求），但失败**原因**记进冷却表，避免每次渲染都重试。
      cache.delete(url);
      throw error;
    });
    cache.set(url, pending);
  }
  try {
    const mod = (await pending) as { default?: unknown };
    return mod.default ?? mod;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failureCache().set(entry, { message, at: Date.now() });
    console.error(`[frontend-runtime] failed to load ${kind}/${id}:`, error);
    // 跨进程可见性（P1-A）：运行期装载失败发生在 **web** 进程的内存里，
    // 而后台「插件管理」页的数据来自 **api** 进程 —— 两者不共享内存，
    // 于是插件前端已经坏掉、管理页却仍旧显示「已激活」。
    // 两个容器共享 `stackpanel-data` 卷，写一份状态快照即可跨进程。
    recordFrontendLoadFailure(kind, id, message);
    return null;
  }
}

/**
 * 是否启用运行期装载（阶段 5 起**默认开**）。
 *
 * - `STACKPANEL_FRONTEND_RUNTIME_LOAD=1`：强制运行期装载（宿主从 `data/` 动态
 *   `import()` 已编译入口）。
 * - `STACKPANEL_FRONTEND_RUNTIME_LOAD=0`：回退到构建期静态 registry（可回退路径，
 *   保持已有部署行为）。
 * - 未设置：默认运行期装载（阶段 5 目标——安装前端不再需要 `next build` + 重启）。
 */
export function runtimeFrontendLoadingEnabled(): boolean {
  return process.env.STACKPANEL_FRONTEND_RUNTIME_LOAD !== '0';
}

/**
 * 插件 admin 浏览器入口的同源 URL（M2）。发布期已把宿主 ABI 说明符改写为受控
 * 适配器导入（`dist/admin.runtime.js`），故这里只需给出其真实位置；优先版本化
 * revision 目录，与 `runtimeFrontendEntry` 的服务端入口同版本。
 */
export function runtimeAdminModuleUrl(
  kind: 'themes' | 'plugins',
  id: string,
  revision?: string,
): string {
  const kernelPath = revision
    ? `/${kind}/${id}/frontend/${revision}/dist/admin.runtime.js`
    : `/${kind}/${id}/frontend/dist/admin.runtime.js`;
  return apiAssetUrl(kernelPath);
}
