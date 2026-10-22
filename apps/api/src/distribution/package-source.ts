/**
 * 包下载与校验流水线（PLAN-github-distribution-and-updates §3.2、§3.3、§7.1、§10）。
 *
 * 把「按目录条目定位 GitHub Release asset → 下载（限流/大小/重定向约束）→ 校验
 * 大小与 SHA-256 → 解压 → 校验包签名并绑定发布者/仓库」串成一条可测流程。这是
 * 统一安装事务（§7）`resolve`/`verify` 两步的内核实现，市场、上传、自动更新共用。
 *
 * 关键约束：
 * - **下载与验签不得降低要求**：大小/摘要任一不符即拒；签名必须由 keyring 绑定。
 * - 资产重定向到对象存储由 {@link downloadAsset} 逐跳约束（HTTPS、允许域名、跨源
 *   剥离 token）。
 * - 目录只**引用**，包体从对应 Release 下载（§2）。
 */

import { unzipSync } from 'fflate';
import { parsePackageSignatureFile, verifyPackageSignatureBound } from './signatures.ts';
import { downloadAsset, fetchTextConditional, GitHubSourceError } from './github-source.ts';
import type { SourceCache } from './github-source.ts';
import type { PackageManifest, Keyring } from '@stackpanel/spec';

export class PackageFetchError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'too_large' | 'digest_mismatch' | 'signature' | 'invalid_archive',
  ) {
    super(message);
  }
}

/** 解压后单个文件路径 → 字节。 */
export type FileMap = Map<string, Uint8Array>;

/** 单文件字节上限（与内核 ZIP 上传限制对齐，§7.1）。 */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 256;
/** ZIP 与解压后总大小上限。 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;

interface GitHubReleaseAsset {
  name: string;
  size: number;
  browser_download_url?: string;
}

/**
 * 通过 GitHub API 定位某 release tag 下指定名称的 asset 下载地址。
 * 公共仓库匿名读取；私有仓库可传只读 token（浏览器与插件不可见）。
 */
export async function resolveReleaseAssetUrl(input: {
  repository: string;
  tag: string;
  asset: string;
  cache: SourceCache;
  token?: string;
  mirror?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ url: string; size: number }> {
  const apiUrl = `https://api.github.com/repos/${input.repository}/releases/tags/${encodeURIComponent(input.tag)}`;
  const result = await fetchTextConditional(apiUrl, input.cache, {
    ...(input.token ? { token: input.token } : {}),
    ...(input.mirror ? { mirror: input.mirror } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (!result.body) throw new PackageFetchError(`Release ${input.tag} 不可用`, 'not_found');
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new PackageFetchError('Release 元数据不是有效的 JSON', 'invalid_archive');
  }
  const assets = (parsed as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) throw new PackageFetchError('Release 缺少 assets', 'not_found');
  const match = (assets as GitHubReleaseAsset[]).find((entry) => entry.name === input.asset);
  if (!match) {
    throw new PackageFetchError(`Release ${input.tag} 中找不到资产 ${input.asset}`, 'not_found');
  }
  const url =
    match.browser_download_url ??
    `https://api.github.com/repos/${input.repository}/releases/assets/${encodeURIComponent(match.name)}`;
  return { url, size: typeof match.size === 'number' ? match.size : 0 };
}

/** 解压 ZIP，做数量与字节上限校验；拒绝路径越界。 */
export function unpackArchive(bytes: Uint8Array): FileMap {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new PackageFetchError(`归档超过上限 ${MAX_ARCHIVE_BYTES} 字节`, 'too_large');
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new PackageFetchError('归档不是有效的 ZIP', 'invalid_archive');
  }
  const files: FileMap = new Map();
  let total = 0;
  let count = 0;
  for (const [rawName, data] of Object.entries(entries)) {
    const name = rawName.replace(/\\/g, '/');
    if (name.startsWith('/') || name.split('/').some((segment) => segment === '..')) {
      throw new PackageFetchError(`归档包含越界路径：${rawName}`, 'invalid_archive');
    }
    if (name.endsWith('/')) continue;
    count += 1;
    if (count > MAX_FILES) {
      throw new PackageFetchError(`归档文件数超过上限 ${MAX_FILES}`, 'too_large');
    }
    if (data.byteLength > MAX_ENTRY_BYTES) {
      throw new PackageFetchError(
        `归档内文件 ${name} 超过上限 ${MAX_ENTRY_BYTES} 字节`,
        'too_large',
      );
    }
    total += data.byteLength;
    if (total > MAX_UNCOMPRESSED_BYTES) {
      throw new PackageFetchError(`解压后总大小超过上限 ${MAX_UNCOMPRESSED_BYTES}`, 'too_large');
    }
    files.set(name, new Uint8Array(data));
  }
  if (files.size === 0) throw new PackageFetchError('归档为空', 'invalid_archive');
  return files;
}

/**
 * 下载并校验一个目录条目指向的包。
 *
 * 步骤（不可跳过、不可降级）：
 * 1. 由目录条目定位 Release asset（`source.repository`/`source.tag`/`source.asset`）。
 * 2. 下载（限流/大小/重定向约束）并核对字节大小与 SHA-256（对照 `artifact`）。
 * 3. 解压并校验包签名，公钥必须由 keyring 绑定到 `publisher` 与来源仓库。
 *
 * @returns 已验证的解压文件集合；调用方继续做 staging/物化（§7）。
 */
export async function fetchAndVerifyPackage(input: {
  manifest: PackageManifest;
  cache: SourceCache;
  keyring: Keyring;
  /** 目录绑定的发布者与签名 keyId（由目录 `publishers` 白名单解析而来）。 */
  publisher: string;
  keyId: string;
  token?: string;
  mirror?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** 注入解压（测试）。缺省 {@link unpackArchive}。 */
  unpack?: (bytes: Uint8Array) => FileMap;
}): Promise<{ files: FileMap; sha256: string; size: number }> {
  const { manifest, cache, keyring, publisher, keyId } = input;
  const { repository, tag, asset } = manifest.source;

  let resolved: { url: string; size: number };
  try {
    resolved = await resolveReleaseAssetUrl({
      repository,
      tag,
      asset,
      cache,
      ...(input.token ? { token: input.token } : {}),
      ...(input.mirror ? { mirror: input.mirror } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
  } catch (error) {
    if (error instanceof PackageFetchError || error instanceof GitHubSourceError) throw error;
    throw new PackageFetchError('定位 Release asset 失败', 'not_found');
  }

  const download = await downloadAsset(resolved.url, {
    ...(input.token ? { token: input.token } : {}),
    ...(input.mirror ? { mirror: input.mirror } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    maxBytes: MAX_ARCHIVE_BYTES,
  });
  if (download.size !== manifest.artifact.size) {
    throw new PackageFetchError(
      `包大小不符：期望 ${manifest.artifact.size}，实际 ${download.size}`,
      'digest_mismatch',
    );
  }
  if (download.sha256 !== manifest.artifact.sha256) {
    throw new PackageFetchError('包 SHA-256 与目录不一致', 'digest_mismatch');
  }

  const files = (input.unpack ?? unpackArchive)(download.bytes);
  try {
    // 签名结构自检（明确区分「缺签名」与「签名不匹配」）。
    const signatureRaw = files.get('signature.json');
    if (!signatureRaw) throw new PackageFetchError('包缺少 signature.json', 'signature');
    parsePackageSignatureFile(signatureRaw);
    verifyPackageSignatureBound({
      files,
      keyId,
      expectedPublisher: publisher,
      expectedRepository: repository,
      keyring,
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    if (error instanceof PackageFetchError) throw error;
    throw new PackageFetchError(
      `包签名校验失败：${error instanceof Error ? error.message : String(error)}`,
      'signature',
    );
  }
  return { files, sha256: download.sha256, size: download.size };
}
