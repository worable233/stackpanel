import 'server-only';

import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
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
};

function moduleCache(): Map<string, Promise<unknown>> {
  if (!g.__STACKPANEL_RUNTIME_MODULES__) g.__STACKPANEL_RUNTIME_MODULES__ = new Map();
  return g.__STACKPANEL_RUNTIME_MODULES__;
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
  let pending = cache.get(url);
  if (!pending) {
    pending = import(/* turbopackIgnore: true */ /* webpackIgnore: true */ url).catch((error) => {
      // 加载失败不要缓存：一次瞬时失败不应永久毒化后续请求。
      cache.delete(url);
      throw error;
    });
    cache.set(url, pending);
  }
  try {
    const mod = (await pending) as { default?: unknown };
    return mod.default ?? mod;
  } catch {
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
