/**
 * 市场目录契约（PLAN-github-distribution-and-updates §2、§3.3）。
 *
 * 目录 = 一棵**只引用**允许仓库 / release / asset / 摘要 / 签名身份 / 兼容性信息
 * 的签名快照；安装包本体从对应 Release 下载。目录采用 `catalog-v1/<sequence>`
 * 唯一 Release tag，含 `catalog.json` 与 `catalog.sig`。
 *
 * 安全约束（全部可测）：
 * - 目录签名绑定 sequence、生成时间、有效期与各版本包摘要；**持久化最高
 *   sequence，拒绝回放旧目录**。
 * - 过期目录可继续显示缓存，但**禁止据其发起新自动安装**。
 * - 撤回版本从候选移除。
 * - 固定名称的 stable/beta 渠道只负责**发现目录快照**；客户端取得固定版本快照
 *   后验证签名（不能用渠道指针替代验证）。
 */

import { createHash } from 'node:crypto';
import { validatePackageManifest, type PackageManifest, type ReleaseChannel } from './manifest.js';

/** 目录格式版本。 */
export const CATALOG_SNAPSHOT_FORMAT_VERSION = 1;

/** 目录中的一条组件版本引用。 */
export interface CatalogEntry extends PackageManifest {
  /** 是否已被撤回（撤回版本从候选中移除）。 */
  revoked?: boolean;
}

/**
 * 目录对**内核版本清单**的引用（PLAN-github-distribution-and-updates §2、§3.2、§13-4）。
 *
 * 内核清单比包清单多出多架构 digest、迁移路径、updateProtocol 等字段，形状不同，
 * 故不塞进 {@link CatalogEntry}。目录只**引用**内核 Release 中的
 * `kernel-manifest.json` / `kernel-manifest.sig`（仓库、tag、asset、清单摘要、
 * 签名 keyId），实例端取回后按 keyring 独立验签（keyId 用途 `kernel`）。
 */
export interface CatalogKernelRef {
  /** 内核产品版本 `X.Y.Z`。 */
  version: string;
  channel: ReleaseChannel;
  source: {
    repository: string;
    tag: string;
    asset: string;
  };
  /** `kernel-manifest.json` 的 SHA-256（十六进制），与清单签名相互独立。 */
  digest: string;
  /** 签名 keyId（对应信任根中用途为 `kernel` 的公钥）。 */
  keyId: string;
  /** 是否已被撤回（撤回版本从候选中移除）。 */
  revoked?: boolean;
}

/** 渠道指针：把 stable/beta 映射到某个已签名的目录 sequence。 */
export interface ChannelPointer {
  channel: ReleaseChannel;
  /** 目标目录 sequence；客户端据此取固定快照。 */
  sequence: number;
}

/**
 * 一份已签名的目录快照。
 *
 * 注意 `sequence` 必须单调递增；客户端**持久化见过的最高 sequence**，对更低
 * sequence 一律拒绝（防回放）。
 */
export interface CatalogSnapshot {
  formatVersion: number;
  /** 单调递增的发布序号。 */
  sequence: number;
  /** 生成时间（ISO）。 */
  generatedAt: string;
  /** 有效期截止（ISO）。过期仍可显示缓存，但禁止发起新自动安装。 */
  expiresAt: string;
  /** 渠道指针（stable/beta → sequence）。 */
  channels: ChannelPointer[];
  /** 可信发布者 keyId → 允许签名的用途/仓库（见信任链）。 */
  publishers: CatalogPublisher[];
  /** 组件版本条目。 */
  entries: CatalogEntry[];
  /**
   * 内核版本引用（可选；缺省表示本目录不含内核更新）。见 {@link CatalogKernelRef}。
   * 为向后兼容设为可选：旧目录快照无此字段仍合法。
   */
  kernels?: CatalogKernelRef[];
}

export interface CatalogPublisher {
  /** 发布者稳定标识。 */
  publisher: string;
  /** 该发布者允许用于包签名的公钥 keyId。 */
  keyIds: string[];
  /** 允许发布组件的仓库白名单。 */
  repositories: string[];
}

/** 目录签名文件 `catalog.sig` 的形状（Ed25519）。 */
export interface CatalogSignature {
  algorithm: 'ed25519';
  /** 签名密钥标识（对应信任根中的 keyId）。 */
  keyId: string;
  /** 被签名内容的 SHA-256（对 `catalog.json` 规范化字节）。 */
  digest: string;
  /** base64 签名。 */
  signature: string;
}

export interface CatalogIssue {
  path: string;
  message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireIsoDate(issues: CatalogIssue[], value: unknown, path: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    issues.push({ path, message: '必须是 ISO 日期字符串' });
  }
}

/**
 * 校验目录快照的自洽性。**不**验证签名（签名由 {@link verifyCatalogSignature}
 * 用信任根单独验证）；本函数只保证结构合法。
 */
export function validateCatalogSnapshot(input: unknown): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  if (!isPlainObject(input)) return [{ path: '', message: '目录必须是对象' }];
  const catalog = input as Record<string, unknown>;

  if (catalog.formatVersion !== CATALOG_SNAPSHOT_FORMAT_VERSION) {
    issues.push({ path: 'formatVersion', message: `必须是 ${CATALOG_SNAPSHOT_FORMAT_VERSION}` });
  }
  if (
    typeof catalog.sequence !== 'number' ||
    !Number.isInteger(catalog.sequence) ||
    catalog.sequence < 1
  ) {
    issues.push({ path: 'sequence', message: '必须是 ≥1 的整数' });
  }
  requireIsoDate(issues, catalog.generatedAt, 'generatedAt');
  requireIsoDate(issues, catalog.expiresAt, 'expiresAt');
  if (
    typeof catalog.generatedAt === 'string' &&
    typeof catalog.expiresAt === 'string' &&
    Date.parse(catalog.expiresAt) < Date.parse(catalog.generatedAt)
  ) {
    issues.push({ path: 'expiresAt', message: '不得早于 generatedAt' });
  }

  if (!Array.isArray(catalog.channels)) {
    issues.push({ path: 'channels', message: '必须是数组' });
  } else {
    const seen = new Set<string>();
    catalog.channels.forEach((channel, index) => {
      const path = `channels[${index}]`;
      if (!isPlainObject(channel)) {
        issues.push({ path, message: '必须是对象' });
        return;
      }
      if (channel.channel !== 'stable' && channel.channel !== 'beta') {
        issues.push({ path: `${path}.channel`, message: '必须是 stable 或 beta' });
      } else if (seen.has(channel.channel)) {
        issues.push({ path: `${path}.channel`, message: `重复渠道：${channel.channel}` });
      } else {
        seen.add(channel.channel);
      }
      if (
        typeof channel.sequence !== 'number' ||
        !Number.isInteger(channel.sequence) ||
        channel.sequence < 1
      ) {
        issues.push({ path: `${path}.sequence`, message: '必须是 ≥1 的整数' });
      }
    });
  }

  if (!Array.isArray(catalog.publishers)) {
    issues.push({ path: 'publishers', message: '必须是数组' });
  } else {
    catalog.publishers.forEach((publisher, index) => {
      const path = `publishers[${index}]`;
      if (!isPlainObject(publisher)) {
        issues.push({ path, message: '必须是对象' });
        return;
      }
      if (typeof publisher.publisher !== 'string' || publisher.publisher.length === 0) {
        issues.push({ path: `${path}.publisher`, message: '必须是非空字符串' });
      }
      for (const key of ['keyIds', 'repositories'] as const) {
        if (!Array.isArray(publisher[key])) {
          issues.push({ path: `${path}.${key}`, message: '必须是数组' });
        }
      }
    });
  }

  if (!Array.isArray(catalog.entries)) {
    issues.push({ path: 'entries', message: '必须是数组' });
  } else {
    catalog.entries.forEach((entry, index) => {
      const path = `entries[${index}]`;
      if (!isPlainObject(entry)) {
        issues.push({ path, message: '必须是对象' });
        return;
      }
      // 条目本身必须是一份合法包清单（复用 manifest 校验，不复制规则）。
      issues.push(...validateEntryManifest(entry, path));
      if (entry.revoked !== undefined && typeof entry.revoked !== 'boolean') {
        issues.push({ path: `${path}.revoked`, message: '必须是布尔值' });
      }
    });
  }

  if (catalog.kernels !== undefined) {
    if (!Array.isArray(catalog.kernels)) {
      issues.push({ path: 'kernels', message: '必须是数组' });
    } else {
      catalog.kernels.forEach((kernel, index) => {
        issues.push(...validateKernelRef(kernel, `kernels[${index}]`));
      });
    }
  }
  return issues;
}

/** 内核引用结构校验（不验证签名——签名由 keyring 单独校验）。 */
function validateKernelRef(input: unknown, path: string): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  if (!isPlainObject(input)) return [{ path, message: '必须是对象' }];
  const ref = input as Record<string, unknown>;
  if (typeof ref.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/.test(ref.version)) {
    issues.push({ path: `${path}.version`, message: '必须是 X.Y.Z 版本' });
  }
  if (ref.channel !== 'stable' && ref.channel !== 'beta') {
    issues.push({ path: `${path}.channel`, message: '必须是 stable 或 beta' });
  }
  if (!isPlainObject(ref.source)) {
    issues.push({ path: `${path}.source`, message: '必须是对象' });
  } else {
    for (const key of ['repository', 'tag', 'asset'] as const) {
      const value = (ref.source as Record<string, unknown>)[key];
      if (typeof value !== 'string' || value.length === 0) {
        issues.push({ path: `${path}.source.${key}`, message: '必须是非空字符串' });
      }
    }
  }
  if (typeof ref.digest !== 'string' || !/^[0-9a-f]{64}$/.test(ref.digest)) {
    issues.push({ path: `${path}.digest`, message: '必须是 64 位小写十六进制' });
  }
  if (typeof ref.keyId !== 'string' || ref.keyId.length === 0) {
    issues.push({ path: `${path}.keyId`, message: '必须是非空字符串' });
  }
  if (ref.revoked !== undefined && typeof ref.revoked !== 'boolean') {
    issues.push({ path: `${path}.revoked`, message: '必须是布尔值' });
  }
  return issues;
}

function validateEntryManifest(entry: Record<string, unknown>, path: string): CatalogIssue[] {
  // manifest 不反向依赖 catalog，无循环。
  return validatePackageManifest(entry).map((issue) => ({
    path: issue.path ? `${path}.${issue.path}` : path,
    message: issue.message,
  }));
}

/**
 * 判断目录是否已过期（相对 `now`）。过期目录仍可展示缓存，但禁止发起新自动安装。
 */
export function isCatalogExpired(catalog: CatalogSnapshot, now: Date = new Date()): boolean {
  return Date.parse(catalog.expiresAt) < now.getTime();
}

/** 回放判定：`incoming` 的 sequence 是否比已持久化的最高 sequence 更新（严格递增）。 */
export function isNewerSequence(incoming: number, highestSeen: number): boolean {
  return incoming > highestSeen;
}

/** 若渠道指针存在，返回它指向的 sequence（渠道只负责发现目录快照）。 */
export function channelSequence(catalog: CatalogSnapshot, channel: ReleaseChannel): number | null {
  return catalog.channels.find((pointer) => pointer.channel === channel)?.sequence ?? null;
}

/** 目录 tag 形状：`catalog-v1/<sequence>`。 */
export function catalogReleaseTag(sequence: number): string {
  return `catalog-v${CATALOG_SNAPSHOT_FORMAT_VERSION}/${sequence}`;
}

/**
 * 递归、稳定地序列化一个 JSON 值：对象键按升序排列，数组保持顺序，无多余空白。
 * 供发布端生成 `catalog.json` 与实例端重算摘要共用，避免「键序不同 → 摘要不同」。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** 目录快照的规范化字节（UTF-8）；`catalog.json` 必须逐字写入本结果。 */
export function canonicalizeCatalogSnapshot(snapshot: CatalogSnapshot): Uint8Array {
  return new TextEncoder().encode(stableStringify(snapshot));
}

/**
 * 目录摘要：对规范化字节取 SHA-256（64 位小写十六进制）。
 * 与内核验签共用同一算法，签名对象即本摘要字符串的 UTF-8 字节。
 */
export function catalogDigest(catalogBytes: Uint8Array): string {
  return createHash('sha256').update(catalogBytes).digest('hex');
}

/** 从目录 tag 解析 sequence；非法返回 null。 */
export function parseCatalogReleaseTag(tag: string): number | null {
  const match = /^catalog-v(\d+)\/(\d+)$/.exec(tag);
  if (!match) return null;
  const [format, sequence] = [Number(match[1]), Number(match[2])];
  if (format !== CATALOG_SNAPSHOT_FORMAT_VERSION) return null;
  return Number.isInteger(sequence) && sequence >= 1 ? sequence : null;
}

/** 目录中某个组件的全部（未撤回）候选版本。 */
export function catalogCandidates(
  catalog: CatalogSnapshot,
  kind: PackageManifest['kind'],
  id: string,
): CatalogEntry[] {
  return catalog.entries.filter(
    (entry) => entry.kind === kind && entry.id === id && !entry.revoked,
  );
}

/** 目录中的内核引用（未撤回），按渠道过滤、版本降序。 */
export function catalogKernelRefs(
  catalog: CatalogSnapshot,
  channel?: ReleaseChannel,
): CatalogKernelRef[] {
  return (catalog.kernels ?? [])
    .filter((ref) => !ref.revoked && (channel === undefined || ref.channel === channel))
    .sort((a, b) => (a.version < b.version ? 1 : a.version > b.version ? -1 : 0));
}
