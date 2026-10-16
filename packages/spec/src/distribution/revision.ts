/**
 * revision（内容摘要）契约（PLAN-github-distribution-and-updates §3.1；
 * runtime-frontend-contracts/04）。
 *
 * 关键约束：
 * - revision = **完整 SHA-256 内容摘要**，与 SemVer 版本号不可混用。
 * - 摘要计算覆盖**规范化文件清单及全部受保护文件**；清单不含自身 revision、签名等
 *   派生字段，避免自引用哈希。
 * - 路径、顺序、编码算法必须唯一——因此这里把「规范化」写死为可复现算法，供内核
 *   与发布端共用同一把尺。
 */

import { createHash } from 'node:crypto';

/** 单个受保护文件的内容摘要。 */
export interface RevisionFile {
  /** 包内相对路径，POSIX 分隔符，不含 `./` 前缀。 */
  path: string;
  /** 64 位小写十六进制 SHA-256。 */
  sha256: string;
  /** 字节数。 */
  size: number;
}

/** 不含自身 revision 的文件清单（可被哈希的输入）。 */
export interface RevisionManifest {
  /** 清单格式版本。 */
  formatVersion: number;
  files: RevisionFile[];
}

export const REVISION_FORMAT_VERSION = 1;

/**
 * 规范化路径：统一为 POSIX 分隔、去掉开头的 `./`。非法路径（绝对路径 / `..`）
 * 抛错——不得把越界路径纳入摘要。
 */
export function normalizeRevisionPath(input: string): string {
  const posix = input.replace(/\\/g, '/');
  if (posix.startsWith('/')) throw new Error(`revision 路径不得为绝对路径：${input}`);
  const stripped = posix.replace(/^\.\//, '');
  if (stripped.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error(`revision 路径包含非法段：${input}`);
  }
  return stripped;
}

/**
 * 构建文件清单：按路径排序、去重，保证跨平台一致。传入的是「已解析的文件字节」。
 * 调用方负责先排除签名与派生文件（`signature.json`、上一版 `revision`）。
 */
export function buildRevisionManifest(
  files: Iterable<{ path: string; data: Uint8Array }>,
  /** 需排除的派生产物名（如 `signature.json`）。 */
  exclude: Iterable<string> = [],
): RevisionManifest {
  const excluded = new Set([...exclude].map((name) => normalizeRevisionPath(name)));
  const byPath = new Map<string, Uint8Array>();
  for (const file of files) {
    const path = normalizeRevisionPath(file.path);
    if (excluded.has(path)) continue;
    byPath.set(path, file.data);
  }
  const entries: RevisionFile[] = [...byPath.entries()]
    .map(([path, data]) => ({
      path,
      sha256: createHash('sha256').update(data).digest('hex'),
      size: data.byteLength,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { formatVersion: REVISION_FORMAT_VERSION, files: entries };
}

/** 稳定序列化清单（键序固定、无空白），作为哈希输入。 */
export function canonicalizeRevisionManifest(manifest: RevisionManifest): string {
  const files = manifest.files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    size: file.size,
  }));
  return JSON.stringify({ formatVersion: manifest.formatVersion, files });
}

/**
 * 计算 revision：对规范化清单取完整 SHA-256（64 位十六进制）。
 * 清单若含派生字段会自引用，因此调用方必须使用 {@link buildRevisionManifest}。
 */
export function computeRevision(manifest: RevisionManifest): string {
  return createHash('sha256').update(canonicalizeRevisionManifest(manifest)).digest('hex');
}

/** 语义校验：revision 必须恰好是 64 位小写十六进制。 */
export function isRevision(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** 单文件摘要（对外暴露，供 loader 校验资源）。 */
export function fileSha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
