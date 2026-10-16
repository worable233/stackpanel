/**
 * 目录消费端（PLAN-github-distribution-and-updates §2、§3.3、§4、§7）。
 *
 * 把一份**已验证签名**的目录快照转成安装/更新所需的两件事：
 *
 * 1. **候选清单**：按 `(kind,id)` 分组、剔除撤回版本，交给 §4 的兼容性求解
 *    （{@link selectTargetVersion} / {@link resolveDeployment}）选目标版本——只按
 *    SemVer + 渠道 + pin，不用 GitHub latest。
 * 2. **信任归属**：把条目绑定到目录 `publishers` 白名单里的发布者与包签名 keyId，
 *    再交给 `fetchAndVerifyPackage` 下载校验。目录只**引用**，**不**自我授权：
 *    发布者必须显式出现在目录白名单，且其仓库必须匹配条目来源仓库。
 *
 * 本模块是纯函数（除类型外零依赖），便于契约测试；下载/落盘分别由
 * `package-source.ts` 与 `packages/**` 承担。
 */

import type {
  CandidateSource,
  CatalogEntry,
  CatalogSnapshot,
  Keyring,
  PackageManifest,
} from '@stackpanel/spec';
export interface PublisherBinding {
  publisher: string;
  /** 用于校验条目包签名的 keyId（取自目录白名单）。 */
  keyId: string;
}

export class CatalogConsumerError extends Error {
  constructor(
    message: string,
    readonly kind: 'unknown_publisher' | 'repository_not_allowed' | 'missing_key',
  ) {
    super(message);
  }
}

/** 把目录条目按 `(kind,id)` 分组为候选来源，剔除撤回版本，确定性排序。 */
export function catalogCandidateSources(catalog: CatalogSnapshot): CandidateSource[] {
  const groups = new Map<string, CandidateSource>();
  for (const entry of catalog.entries) {
    if (entry.revoked) continue;
    const key = `${entry.kind}:${entry.id}`;
    const group = groups.get(key) ?? { kind: entry.kind, id: entry.id, manifests: [] };
    group.manifests.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      // 稳定排序（版本降序）便于展示与测试；求解器本身不依赖顺序。
      manifests: [...group.manifests].sort((a, b) => (a.version < b.version ? 1 : -1)),
    }))
    .sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
}

/**
 * 解析条目的信任归属：发布者必须在目录 `publishers` 白名单中，来源仓库必须匹配
 * 该发布者声明的仓库，且至少要有一个可用于包签名的 keyId。
 */
export function resolvePublisherBinding(
  catalog: CatalogSnapshot,
  entry: Pick<CatalogEntry, 'publisher' | 'source'>,
): PublisherBinding {
  const publisher = entry.publisher;
  if (!publisher) {
    throw new CatalogConsumerError('目录条目缺少 publisher 归属', 'unknown_publisher');
  }
  const declared = catalog.publishers.find((candidate) => candidate.publisher === publisher);
  if (!declared) {
    throw new CatalogConsumerError(`发布者 ${publisher} 不在目录信任白名单内`, 'unknown_publisher');
  }
  if (!declared.repositories.includes(entry.source.repository)) {
    throw new CatalogConsumerError(
      `来源仓库 ${entry.source.repository} 不属于发布者 ${publisher}`,
      'repository_not_allowed',
    );
  }
  const keyId = declared.keyIds[0];
  if (!keyId) {
    throw new CatalogConsumerError(`发布者 ${publisher} 没有可用的签名 keyId`, 'missing_key');
  }
  return { publisher, keyId };
}

/**
 * 从信任根里挑出该条目可用的**目录绑定** keyId。目录只声明 keyId，实际公钥必须
 * 存在于 keyring，且用途为 `package`、允许该来源仓库——否则拒绝，避免目录用一把
 * 未随内核安装的钥匙给包背书。
 */
export function resolveUsableKeyId(
  keyring: Keyring,
  binding: PublisherBinding,
  manifest: Pick<PackageManifest, 'source'>,
  now: Date = new Date(),
): string {
  const key = keyring.keys.find((candidate) => candidate.keyId === binding.keyId);
  if (!key) {
    throw new CatalogConsumerError(
      `信任根缺少 keyId ${binding.keyId}（目录声明但内核不信任）`,
      'missing_key',
    );
  }
  if (key.purpose !== 'package') {
    throw new CatalogConsumerError(`keyId ${binding.keyId} 用途不是 package`, 'missing_key');
  }
  if (key.revoked) {
    throw new CatalogConsumerError(`keyId ${binding.keyId} 已撤销`, 'missing_key');
  }
  if (key.notBefore && Date.parse(key.notBefore) > now.getTime()) {
    throw new CatalogConsumerError(`keyId ${binding.keyId} 尚未生效`, 'missing_key');
  }
  if (key.notAfter && Date.parse(key.notAfter) < now.getTime()) {
    throw new CatalogConsumerError(`keyId ${binding.keyId} 已过期`, 'missing_key');
  }
  if (
    key.allowedRepositories &&
    key.allowedRepositories.length > 0 &&
    !key.allowedRepositories.includes(manifest.source.repository)
  ) {
    throw new CatalogConsumerError(
      `keyId ${binding.keyId} 不允许来源仓库 ${manifest.source.repository}`,
      'repository_not_allowed',
    );
  }
  return binding.keyId;
}
