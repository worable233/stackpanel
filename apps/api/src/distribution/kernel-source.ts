/**
 * 内核清单获取与校验（PLAN-github-distribution-and-updates §2、§3.2、§3.3、§13-4）。
 *
 * 自动更新内核需要一份**已签名**的内核版本清单（多架构 digest、迁移路径、
 * updateProtocol、schemaRange 等）。目录只**引用**（仓库/tag/asset/摘要/keyId），
 * 实例端从此处取回后：
 *
 * 1. 由 {@link CatalogKernelRef} 定位 Release asset（复用包下载同一套限流/重定向/大小约束）。
 * 2. 核对字节 SHA-256（对照引用声明的 `digest`），再做结构校验。
 * 3. 用 keyring 中用途为 `kernel` 的公钥验证 `kernel-manifest.sig`（不降级、不跳过）。
 *
 * 不信任「目录自称可自动更新」：清单必须既通过目录摘要、又通过独立内核签名，才允许
 * 作为升级目标。
 */

import { downloadAsset } from './github-source.ts';
import type { SourceCache } from './github-source.ts';
import { resolveReleaseAssetUrl, PackageFetchError } from './package-source.ts';
import {
  isValidKernelManifest,
  verifyKernelManifestSignature,
  type CatalogKernelRef,
  type KernelManifest,
  type KernelManifestSignature,
  type Keyring,
} from '@stackpanel/spec';

export class KernelManifestError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_found' | 'digest_mismatch' | 'invalid' | 'signature',
  ) {
    super(message);
  }
}

/** 与 `kernel-manifest.json` 同级、约定命名的签名文件。 */
const KERNEL_SIGNATURE_ASSET = 'kernel-manifest.sig';

export interface FetchKernelManifestResult {
  manifest: KernelManifest;
  sha256: string;
  size: number;
  keyId: string;
}

/**
 * 取回并校验一个内核清单引用。失败的每一类都显式区分（不降级为「可用」）。
 */
export async function fetchAndVerifyKernelManifest(input: {
  ref: CatalogKernelRef;
  cache: SourceCache;
  keyring: Keyring;
  token?: string;
  mirror?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** 覆盖签名资产名（默认 `kernel-manifest.sig`，与清单同 tag）。 */
  signatureAsset?: string;
}): Promise<FetchKernelManifestResult> {
  const { ref, cache, keyring } = input;
  const signatureAsset = input.signatureAsset ?? KERNEL_SIGNATURE_ASSET;

  const locate = (asset: string) =>
    resolveReleaseAssetUrl({
      repository: ref.source.repository,
      tag: ref.source.tag,
      asset,
      cache,
      ...(input.token ? { token: input.token } : {}),
      ...(input.mirror ? { mirror: input.mirror } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });

  let manifestUrl: { url: string; size: number };
  let signatureUrl: { url: string; size: number };
  try {
    [manifestUrl, signatureUrl] = await Promise.all([
      locate(ref.source.asset),
      locate(signatureAsset),
    ]);
  } catch (error) {
    if (error instanceof PackageFetchError) {
      throw new KernelManifestError(error.message, 'not_found');
    }
    throw error;
  }

  const [manifestDownload, signatureDownload] = await Promise.all([
    downloadAsset(manifestUrl.url, {
      ...(input.token ? { token: input.token } : {}),
      ...(input.mirror ? { mirror: input.mirror } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      maxBytes: 4 * 1024 * 1024,
    }),
    downloadAsset(signatureUrl.url, {
      ...(input.token ? { token: input.token } : {}),
      ...(input.mirror ? { mirror: input.mirror } : {}),
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      maxBytes: 64 * 1024,
    }),
  ]);

  if (manifestDownload.sha256 !== ref.digest) {
    throw new KernelManifestError('内核清单 SHA-256 与目录引用不一致', 'digest_mismatch');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestDownload.bytes));
  } catch {
    throw new KernelManifestError('内核清单不是有效的 JSON', 'invalid');
  }
  if (!isValidKernelManifest(parsed)) {
    throw new KernelManifestError('内核清单结构非法', 'invalid');
  }

  let signature: KernelManifestSignature;
  try {
    signature = JSON.parse(new TextDecoder().decode(signatureDownload.bytes));
  } catch {
    throw new KernelManifestError('内核清单签名不是有效的 JSON', 'signature');
  }
  try {
    verifyKernelManifestSignature({
      manifestBytes: manifestDownload.bytes,
      signature,
      keyring,
      repository: ref.source.repository,
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    throw new KernelManifestError(
      `内核清单签名校验失败：${error instanceof Error ? error.message : String(error)}`,
      'signature',
    );
  }
  // 目录引用的 keyId 必须就是实际签名者，避免目录用一把 key 背书、另一把 key 签名。
  if (signature.keyId !== ref.keyId) {
    throw new KernelManifestError(
      `内核清单签名者 ${signature.keyId} 与目录引用 ${ref.keyId} 不符`,
      'signature',
    );
  }

  return {
    manifest: parsed as KernelManifest,
    sha256: manifestDownload.sha256,
    size: manifestDownload.size,
    keyId: signature.keyId,
  };
}
