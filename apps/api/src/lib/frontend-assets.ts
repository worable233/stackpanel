/**
 * 前端产物输送契约（PLAN-github-distribution-and-updates §8、§6.6；
 * PLAN-runtime-frontend-loading 契约 04「revision 与重启语义」§1/§2/§5）。
 *
 * 版本化资源服务归属内核 `apps/api`（契约 04 §5），web BFF 只做同源转发。
 * 本模块是**纯逻辑**单一来源：解析版本化路径、校验 manifest 文件白名单、判定
 * MIME 与缓存头。路由层（`routes/theme.ts`、`routes/plugin.ts`）与测试共用，
 * 不各自实现，避免「怎么发」与「怎么验」漂移。
 *
 * 约束：
 * - **同 revision 一致**：版本化路径 `.../frontend/<revision>/<file>` 中的
 *   `<revision>` 必须等于 `manifest.revision`，否则拒绝（不得回退到别的版本）。
 * - **manifest 文件白名单**：只允许 `manifest.files[]` 声明过的文件（相对
 *   `frontend/` 去前缀）与 `manifest.json` 自身。
 * - **不可变缓存**：版本化路径是内容寻址的，可 `immutable` 长缓存；未版本化
 *   路径（legacy）必须 `no-cache` + ETag 校验，因 revision 可能随重装变化。
 */

import type { FrontendManifest } from '@stackpanel/sdk';

/** 版本号形状（内容摘要）：足够长的十六进制串，避免与 `dist/` 等目录名混淆。 */
const REVISION_PATTERN = /^[a-f0-9]{6,64}$/i;

/** 前端文件相对包根的前缀；`manifest.files[]` 以此为前缀。 */
const FRONTEND_PREFIX = 'frontend/';

/** 版本化路径的稳定最长缓存（内容寻址，可 immutable）。 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** 未版本化（legacy）路径：必须带 ETag 校验，避免拿到撕裂版本。 */
export const REVALIDATE_CACHE_CONTROL = 'public, max-age=60, must-revalidate';

export interface ResolvedFrontendAsset {
  /** 命中的 revision（版本化路径）或 null（legacy）。 */
  revision: string | null;
  /** 相对 `frontend/` 的资源路径（如 `dist/index.js`）。 */
  asset: string;
}

export type FrontendAssetResolution =
  { ok: true; value: ResolvedFrontendAsset } | { ok: false; status: 400 | 404; reason: string };

/**
 * 解析一条 `.../frontend/*` 请求的 asset 段为「版本化 / legacy」两种形态。
 *
 * - 若首段等于 `manifest.revision`（形状合规），判定为版本化路径，其余为资源。
 * - 否则整段视为 legacy 资源路径。
 * - 任何 `..`/`\`/空段一律拒绝（路径逃逸）。
 */
export function resolveFrontendAsset(
  manifest: FrontendManifest,
  rawAsset: string,
): FrontendAssetResolution {
  if (!rawAsset) return { ok: false, status: 400, reason: '请求参数无效' };
  const segments = rawAsset.split('/');
  if (
    segments.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))
  ) {
    return { ok: false, status: 400, reason: '非法的前端路径' };
  }
  const [head, ...rest] = segments;
  if (head && REVISION_PATTERN.test(head) && head === manifest.revision) {
    const asset = rest.join('/');
    if (!asset) return { ok: false, status: 400, reason: '请求参数无效' };
    return { ok: true, value: { revision: head, asset } };
  }
  // Head matches a revision *shape* but not the manifest's → a stale/forged
  // versioned URL. Refuse rather than silently serving a different revision.
  if (head && REVISION_PATTERN.test(head)) {
    return { ok: false, status: 404, reason: '前端版本不存在' };
  }
  return { ok: true, value: { revision: null, asset: rawAsset } };
}

/**
 * `manifest.files[]` 白名单校验：`asset` 相对 `frontend/`，白名单条目相对包根。
 * `manifest.json` 自身始终允许。
 */
export function isAllowedFrontendAsset(manifest: FrontendManifest, asset: string): boolean {
  if (asset === 'manifest.json') return true;
  const normalized = asset.replace(/^\.\//, '');
  return manifest.files.some((file) => {
    const relative = file.startsWith(FRONTEND_PREFIX) ? file.slice(FRONTEND_PREFIX.length) : file;
    return relative === normalized;
  });
}

/** 前端资源的 MIME（§6.6：CSS/分块 JS/字体/图片都要正确类型）。 */
export function frontendAssetContentType(asset: string): string {
  const lower = asset.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
  if (lower.endsWith('.json') || lower.endsWith('.map')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.woff')) return 'font/woff';
  if (lower.endsWith('.ttf')) return 'font/ttf';
  return 'application/octet-stream';
}

/**
 * 资源 ETag：绑定 revision + 资源路径。同 revision 内容不可变，故该 ETag 即内容
 * 校验器；换版本必换 ETag（契约 04 §2「同 revision 内一致」的可观测面）。
 */
export function frontendAssetEtag(revision: string, asset: string): string {
  return `"${revision}:${asset}"`;
}

/** 根据解析结果给出 `Cache-Control`（版本化 immutable，legacy 需校验）。 */
export function frontendAssetCacheControl(resolved: ResolvedFrontendAsset): string {
  return resolved.revision ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
}
