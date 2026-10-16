/**
 * 分发签名原语（PLAN-github-distribution-and-updates §3.3）。
 *
 * 发布端（`scripts/release/**`、CI）与实例端共用**同一** Ed25519 载荷与摘要算法，
 * 避免「发布端怎么签」与「实例端怎么验」两处漂移。私钥只在受保护的发布环境；
 * 本模块的签名函数仅应在发布脚本中调用，实例端只调用校验函数。
 *
 * 覆盖两条链：
 * - **目录**：对 `catalog.json` 的规范化字节取 SHA-256 作为签名载荷，输出
 *   `catalog.sig`（{@link CatalogSignature}）。
 * - **包**：沿用 `signature.json`（`{algorithm, files, signature}`），签名字节为
 *   `JSON.stringify({algorithm:'ed25519', files})`（键序与 {@link packageFileDigests}
 *   一致）。
 *
 * 除 `node:crypto` 外零运行时依赖。
 */

import { createHash, createPublicKey, createPrivateKey, sign, verify } from 'node:crypto';
import { catalogDigest, type CatalogSignature } from './catalog.js';
import { catalogKeyAllowed, findKey, packageKeyAllowed, type Keyring } from './trust.js';

const PACKAGE_SIGNATURE_FILE = 'signature.json';
const ALGORITHM = 'ed25519';

/** `signature.json` 形状（与内核 `parsePackageSignatureFile` 一致）。 */
export interface PackageSignatureFile {
  algorithm: 'ed25519';
  /** 每个非签名文件路径 → SHA-256。 */
  files: Record<string, string>;
  signature: string;
}

export class DistributionSignatureError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * 计算包内每个非签名文件的 SHA-256（路径排序，稳定）。发布端与实例端共用，
 * 保证 `signature.json` 的 `files` 键序一致。
 */
export function packageFileDigests(files: Iterable<[string, Uint8Array]>): Record<string, string> {
  const byPath = new Map<string, Uint8Array>();
  for (const [name, data] of files) {
    if (name === PACKAGE_SIGNATURE_FILE) continue;
    byPath.set(name, data);
  }
  const hashes: Record<string, string> = {};
  for (const name of [...byPath.keys()].sort()) {
    const data = byPath.get(name);
    if (!data) continue;
    hashes[name] = createHash('sha256').update(data).digest('hex');
  }
  return hashes;
}

/** 包签名的规范化载荷字节。 */
export function packageSignaturePayload(files: Record<string, string>): Buffer {
  return Buffer.from(JSON.stringify({ algorithm: ALGORITHM, files }), 'utf8');
}

/** 用目录私钥签名 `catalog.json` 的原始字节，产出 `catalog.sig` 内容。 */
export function signCatalog(
  catalogBytes: Uint8Array,
  privateKeyPem: string | Buffer,
  keyId: string,
): CatalogSignature {
  const digest = catalogDigest(catalogBytes);
  const signature = sign(
    null,
    Buffer.from(digest, 'utf8'),
    createPrivateKey(privateKeyPem),
  ).toString('base64');
  return { algorithm: ALGORITHM, keyId, digest, signature };
}

/**
 * 校验目录签名（纯函数，发布脚本自检与内核共用）。
 * `repository` 用于 `allowedRepositories` 判定；不通过时抛 {@link DistributionSignatureError}。
 */
export function verifyCatalogSignatureBytes(input: {
  catalogBytes: Uint8Array;
  signature: CatalogSignature;
  keyring: Keyring;
  repository: string;
  now?: Date;
}): void {
  const { catalogBytes, signature, keyring, repository, now } = input;
  if (signature.algorithm !== ALGORITHM) {
    throw new DistributionSignatureError(`不支持的目录签名算法：${signature.algorithm}`);
  }
  if (signature.digest !== catalogDigest(catalogBytes)) {
    throw new DistributionSignatureError('catalog.json 摘要与 catalog.sig 不一致');
  }
  if (!catalogKeyAllowed(keyring, signature.keyId, repository, now)) {
    throw new DistributionSignatureError(`目录签名者未被信任：${signature.keyId}`);
  }
  const key = findKey(keyring, signature.keyId);
  if (!key) {
    throw new DistributionSignatureError(`信任根中找不到目录签名公钥：${signature.keyId}`);
  }
  const payload = Buffer.from(signature.digest, 'utf8');
  try {
    const publicKey = createPublicKey(key.publicKeyPem);
    const valid = verify(null, payload, publicKey, Buffer.from(signature.signature, 'base64'));
    if (!valid) throw new DistributionSignatureError('目录签名无效');
  } catch (error) {
    if (error instanceof DistributionSignatureError) throw error;
    throw new DistributionSignatureError('无法校验目录签名');
  }
}

/** 用包私钥生成 `signature.json`（目录绑定后由实例端校验）。 */
export function signPackageFiles(
  files: Iterable<[string, Uint8Array]>,
  privateKeyPem: string | Buffer,
): PackageSignatureFile {
  const digests = packageFileDigests(files);
  const signature = sign(
    null,
    packageSignaturePayload(digests),
    createPrivateKey(privateKeyPem),
  ).toString('base64');
  return { algorithm: ALGORITHM, files: digests, signature };
}

/** 解析并做最小结构校验 `signature.json`。 */
export function parsePackageSignatureFile(raw: Uint8Array): PackageSignatureFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new DistributionSignatureError('signature.json 不是有效的 JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { algorithm?: unknown }).algorithm !== ALGORITHM ||
    typeof (parsed as { signature?: unknown }).signature !== 'string' ||
    typeof (parsed as { files?: unknown }).files !== 'object' ||
    (parsed as { files?: unknown }).files === null
  ) {
    throw new DistributionSignatureError('signature.json 无效');
  }
  return parsed as PackageSignatureFile;
}

/**
 * 校验包签名，并**要求**签名公钥属于目录绑定的发布者/仓库。
 * 不信任「上传者提交的公钥」——keyId 必须由目录条目指明且命中 keyring。
 */
export function verifyPackageSignatureBound(input: {
  files: Map<string, Uint8Array>;
  keyId: string;
  expectedPublisher: string;
  expectedRepository: string;
  keyring: Keyring;
  now?: Date;
}): void {
  const { files, keyId, expectedPublisher, expectedRepository, keyring, now } = input;
  if (!packageKeyAllowed(keyring, keyId, expectedPublisher, expectedRepository, now)) {
    throw new DistributionSignatureError(`包签名公钥与目录绑定不符或未被信任：${keyId}`);
  }
  const raw = files.get(PACKAGE_SIGNATURE_FILE);
  if (!raw) throw new DistributionSignatureError('缺少 signature.json');
  const signature = parsePackageSignatureFile(raw);
  const digests = packageFileDigests(files);
  if (JSON.stringify(digests) !== JSON.stringify(signature.files)) {
    throw new DistributionSignatureError('包文件与 signature.json 不一致');
  }
  const key = findKey(keyring, keyId);
  if (!key) throw new DistributionSignatureError(`信任根中找不到包签名公钥：${keyId}`);
  try {
    const publicKey = createPublicKey(key.publicKeyPem);
    const valid = verify(
      null,
      packageSignaturePayload(signature.files),
      publicKey,
      Buffer.from(signature.signature, 'base64'),
    );
    if (!valid) throw new DistributionSignatureError('包签名无效');
  } catch (error) {
    if (error instanceof DistributionSignatureError) throw error;
    throw new DistributionSignatureError('无法校验包签名');
  }
}
