/**
 * 市场目录客户端（PLAN-github-distribution-and-updates §2、§3.3、§10）。
 *
 * 固定名称的 stable/beta 渠道只负责**发现目录快照**；客户端取得固定版本快照后
 * 验证签名。本模块把「取渠道指针 → 取固定 sequence 的 catalog.json/catalog.sig →
 * 校验签名 → 拒绝回放 → 判定过期」串成一条可测流程，并**不**在页面渲染路径调用
 * GitHub（由后台任务与实例级合并刷新驱动）。
 */

import {
  catalogReleaseTag,
  isCatalogExpired,
  validateCatalogSnapshot,
  type CatalogSnapshot,
  type CatalogSignature,
  type Keyring,
  type ReleaseChannel,
} from '@stackpanel/spec';
import {
  fetchTextConditional,
  GitHubSourceError,
  type GitHubSourceOptions,
  type SourceCache,
} from './github-source.ts';
import { DistributionSignatureError, verifyCatalogSignature } from './signatures.ts';

export interface CatalogFetchOptions extends GitHubSourceOptions {
  /** 目录仓，如 `worable233/stackpanel-market`。 */
  repository: string;
  /** 默认读取的分支/ref（目录 tag 走 API 时不必用）。 */
  ref?: string;
}

export interface ResolvedCatalog {
  snapshot: CatalogSnapshot;
  /** 已持久化的最高 sequence（用于下次回放保护）。 */
  sequence: number;
  /** 目录是否已过期（仍可展示缓存，但禁止据其发起新自动安装）。 */
  expired: boolean;
}

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly kind: 'replay' | 'signature' | 'invalid' | 'network' | 'not_found',
  ) {
    super(message);
  }
}

/** 读取 `catalog-v1/<sequence>` tag 下的一个文件（raw.githubusercontent）。 */
function rawUrl(repository: string, tag: string, file: string): string {
  return `https://raw.githubusercontent.com/${repository}/${tag}/${file}`;
}

/**
 * 取得渠道指针指向的 sequence（先解 stable/beta 的固定指针文件）。为保持实现简单
 * 且可测，这里约定渠道指针文件为目录仓默认分支的 `channels.json`。
 */
async function fetchChannelPointer(
  options: CatalogFetchOptions,
  cache: SourceCache,
  channel: ReleaseChannel,
): Promise<number> {
  const ref = options.ref ?? 'main';
  const url = rawUrl(options.repository, ref, 'channels.json');
  const result = await fetchTextConditional(url, cache, options);
  if (!result.body) throw new CatalogError('渠道指针不可用', 'not_found');
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new CatalogError('channels.json 不是有效的 JSON', 'invalid');
  }
  const pointer = Array.isArray((parsed as { channels?: unknown }).channels)
    ? (parsed as { channels: Array<{ channel?: string; sequence?: number }> }).channels.find(
        (entry) => entry.channel === channel,
      )
    : undefined;
  if (!pointer || typeof pointer.sequence !== 'number' || !Number.isInteger(pointer.sequence)) {
    throw new CatalogError(`渠道 ${channel} 没有有效的 sequence`, 'invalid');
  }
  return pointer.sequence;
}

/**
 * 拉取并验证一个固定 sequence 的目录快照。
 *
 * @param highestSequence **该渠道**已持久化的最高 sequence。严格更低的视为回放/降级
 *   并拒绝；**相等**的不是攻击，而是「渠道没有新发布」：固定 tag 的内容不会变，
 *   仍按同一套验签流程取回。若把相等也当错误，目录不推进时每次手动「检查更新」
 *   都会报「拒绝回放旧目录」（多渠道/多进程共享状态时必然遇到）。
 */
export async function fetchCatalogSequenced(
  options: CatalogFetchOptions,
  cache: SourceCache,
  keyring: Keyring,
  sequence: number,
  highestSequence: number,
  now: Date = new Date(),
): Promise<ResolvedCatalog> {
  if (sequence < highestSequence) {
    throw new CatalogError(
      `拒绝回放旧目录：sequence ${sequence} < 已见 ${highestSequence}`,
      'replay',
    );
  }
  const tag = catalogReleaseTag(sequence);
  const catalogUrl = rawUrl(options.repository, tag, 'catalog.json');
  const signatureUrl = rawUrl(options.repository, tag, 'catalog.sig');

  const catalogResult = await fetchTextConditional(catalogUrl, cache, options);
  if (!catalogResult.body) throw new CatalogError('catalog.json 不可用', 'not_found');
  const signatureResult = await fetchTextConditional(signatureUrl, cache, options);
  if (!signatureResult.body) throw new CatalogError('catalog.sig 不可用', 'not_found');

  let signature: CatalogSignature;
  try {
    signature = JSON.parse(signatureResult.body) as CatalogSignature;
  } catch {
    throw new CatalogError('catalog.sig 不是有效的 JSON', 'invalid');
  }
  try {
    verifyCatalogSignature({
      catalogBytes: new TextEncoder().encode(catalogResult.body),
      signature,
      keyring,
      repository: options.repository,
      now,
    });
  } catch (error) {
    if (error instanceof DistributionSignatureError) {
      throw new CatalogError(`目录签名校验失败：${error.message}`, 'signature');
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(catalogResult.body);
  } catch {
    throw new CatalogError('catalog.json 不是有效的 JSON', 'invalid');
  }
  const issues = validateCatalogSnapshot(parsed);
  if (issues.length > 0) {
    throw new CatalogError(
      `目录结构非法：${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
      'invalid',
    );
  }
  const snapshot = parsed as CatalogSnapshot;
  return {
    snapshot,
    sequence: snapshot.sequence,
    expired: isCatalogExpired(snapshot, now),
  };
}

/** 组合：先发现渠道指针，再取固定 sequence 快照。 */
export async function fetchCatalog(
  options: CatalogFetchOptions,
  cache: SourceCache,
  keyring: Keyring,
  channel: ReleaseChannel,
  highestSequence: number,
  now: Date = new Date(),
): Promise<ResolvedCatalog> {
  const sequence = await fetchChannelPointer(options, cache, channel);
  return fetchCatalogSequenced(options, cache, keyring, sequence, highestSequence, now);
}

/**
 * 过期目录不得据其发起**新自动安装**（但可展示缓存）。返回是否允许。
 */
export function mayInstallFromCatalog(resolved: ResolvedCatalog): boolean {
  return !resolved.expired;
}

export { GitHubSourceError };
