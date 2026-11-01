/**
 * 远程目录（GitHub Release）市场接入（PLAN-github-distribution-and-updates §3.4、§7、§13-3）。
 *
 * 把已验证的目录快照接到**市场安装路由**：列表用缓存快照（页面渲染路径不请求
 * GitHub），安装用统一安装事务（§7）——`resolve → verify → stage → apply → commit`：
 *
 * 1. `resolve`：按 `(kind,id)` 分组候选、剔除撤回版本，用 §4 的
 *    {@link selectTargetVersion} 在渠道 + 兼容门禁 + pin 下选目标版本（不用
 *    GitHub latest）。
 * 2. `verify`：`fetchCatalogPackage` 下载 Release asset、核对摘要并**按 keyring 绑定
 *    发布者/仓库**验签（不降级）。
 * 3. `stage`：复用 ZIP 上传同一套包体校验（{@link assemblePluginFiles} /
 *    {@link assembleThemeFiles}），再经统一 {@link PackageManager} 原子切换。
 * 4. `apply` / `commit`：由调用方（路由）在提交前完成运行时 register/activate 与
 *    DB 指针；失败回滚到旧目录。
 *
 * 本模块**不**直接读单例，由 `market.ts` 从分发运行时装配依赖，便于测试注入。
 */

import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import {
  checkPackageCompatibility,
  selectTargetVersion,
  DistributionSignatureError,
  type BlockReasonLike,
  type CatalogEntry,
  type CatalogSnapshot,
  type InstalledComponent,
  type Keyring,
  type KernelCapabilities,
} from '@stackpanel/spec';
import { PluginError } from '@stackpanel/sdk';
import { catalogCandidateSources, fetchCatalogPackage } from '../distribution/catalog-consumer.ts';
import { KeyringError } from '../distribution/keyring.ts';
import type { SourceCache } from '../distribution/index.ts';
import { packageManager, packageDir, type StageHandle } from '../packages/index.ts';
import { kernelCapabilities } from '../distribution/kernel-capabilities.ts';
import { assemblePluginFiles, type PluginManifestFile } from './plugins.ts';
import { assembleThemeFiles, type ThemeManifest } from './themes.ts';

/**
 * 目录安装失败的类型。
 *
 * 安装失败必须能区分「谁该动手」：目录里没这个包（运维看错）、兼容门禁挡住
 * （需要升内核/降版本）、下载不到（网络/加速）、限流（等一会儿）、验签不过（发布
 * 端或信任根）。以前全部压成一句「安装失败」+ 英文 detail，界面无话可说。
 */
export type CatalogMarketFailure =
  | 'not_found'
  | 'blocked'
  | 'fetch'
  | 'mismatch';

export class CatalogMarketError extends Error {
  constructor(
    message: string,
    readonly blocks: BlockReasonLike[] = [],
    readonly failure: CatalogMarketFailure = 'fetch',
    /** 原始错误（`GitHubSourceError` / `PackageFetchError` / …），用于细分错误码。 */
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * 把目录安装异常翻译成**带稳定错误码的插件错误**（ADR-0012 §4、ADR-0016 §3）。
 *
 * 错误码按「操作者下一步该做什么」划分，而不是按实现细节：
 * - `market.notInCatalog` 404：目录里没这个条目（拼错 id / 渠道不含此版本）
 * - `market.packageBlocked` 422：兼容/权限/迁移门禁挡住
 * - `market.trustRootMissing` 422：实例信任根缺这把公钥（补 `trust/keyring.json`）
 * - `market.signatureInvalid` 502：验签、摘要不匹配
 * - `market.packageTooLarge` 413：包体超限
 * - `market.sourceRateLimited` 503：GitHub 限流（带 retryAfterSeconds）
 * - `market.sourceUnavailable` 502：下载不到（网络/HTTP/重定向）
 * - `market.packageInvalid` 502：包体结构非法或与目录条目不一致
 *
 * `detail` 保留原始原因（只进日志与 ProblemDetails，不上屏）。
 */
export function mapCatalogInstallError(error: unknown): PluginError | null {
  if (!(error instanceof CatalogMarketError)) return null;
  const detail = error.message;
  if (error.failure === 'not_found') {
    return new PluginError('market.notInCatalog', 404, detail);
  }
  if (error.failure === 'blocked') {
    const reasons = error.blocks.map((block) => `${block.code}: ${block.detail}`).join('; ');
    return new PluginError('market.packageBlocked', 422, reasons || detail);
  }
  if (error.failure === 'mismatch') {
    return new PluginError('market.packageInvalid', 502, detail);
  }
  const cause = error.cause;
  const kind = fetchFailureKind(cause);
  if (kind === 'too_large') {
    return new PluginError('market.packageTooLarge', 413, detail);
  }
  if (kind === 'rate_limited') {
    const retryAfterSeconds = rateLimitRetrySeconds(cause);
    return new PluginError(
      'market.sourceRateLimited',
      503,
      detail,
      undefined,
      retryAfterSeconds === undefined ? undefined : { retryAfterSeconds },
    );
  }
  if (kind === 'trust_root') {
    // 顶层 message 是「安装 x 失败」，真正缺哪个 keyId 在 cause 里。详情只进日志与
    // ProblemDetails，把 cause 接上才能让运维一眼看到要补什么。
    const causeMessage = cause instanceof Error ? cause.message : '';
    return new PluginError(
      'market.trustRootMissing',
      422,
      causeMessage ? `${detail}（${causeMessage}）` : detail,
    );
  }
  if (kind === 'signature') {
    return new PluginError('market.signatureInvalid', 502, detail);
  }
  if (kind === 'invalid') {
    return new PluginError('market.packageInvalid', 502, detail);
  }
  return new PluginError('market.sourceUnavailable', 502, detail);
}

/** 从各类分发异常里提取一个统一的失败类别（未知一律按「下载不到」）。 */
function fetchFailureKind(cause: unknown, depth = 0): string | null {
  if (!cause || typeof cause !== 'object') return null;
  const kind = (cause as { kind?: unknown }).kind;
  if (typeof kind === 'string') {
    if (kind === 'too_large') return 'too_large';
    if (kind === 'rate_limited') return 'rate_limited';
    if (kind === 'invalid_archive') return 'invalid';
    if (kind === 'digest_mismatch' || kind === 'signature') return 'signature';
    // 信任根类问题单独一类：它们的修法不是「重试」也不是「换个包」，而是把公钥
    // 补进实例的 `trust/keyring.json`。混进 `signature` 时界面只会说「验签失败」，
    // 运维拿不到任何下一步（v0.1.0/v0.1.1 默认部署的真实死因）。
    if (kind === 'unknown_publisher' || kind === 'repository_not_allowed' || kind === 'missing_key') {
      return 'trust_root';
    }
  }
  if (cause instanceof DistributionSignatureError) return 'signature';
  if (cause instanceof KeyringError) return 'signature';
  // 包下载失败有时会把 GitHub 的 429 包在 `cause` 里；不往下看一层，限流就会被
  // 当成「网络不可用」，界面也就无法给出「等 N 秒」。
  if (depth < 2) {
    const nested = fetchFailureKind((cause as { cause?: unknown }).cause, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** `Retry-After` 建议的等待秒数（向上取整；没有就交给调用方兜底）。 */
function rateLimitRetrySeconds(cause: unknown, depth = 0): number | undefined {
  if (!cause || typeof cause !== 'object') return undefined;
  const ms = (cause as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) return Math.max(1, Math.ceil(ms / 1000));
  if (depth >= 2) return undefined;
  return rateLimitRetrySeconds((cause as { cause?: unknown }).cause, depth + 1);
}

/** 远程目录安装所需的、可注入的依赖集合。 */
export interface CatalogInstallDeps {
  catalog: CatalogSnapshot;
  keyring: Keyring;
  cache: SourceCache;
  channel: 'stable' | 'beta';
  token?: string;
  mirror?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export type CatalogKind = 'plugin' | 'theme';

/** 远程目录条目的市场视图（不含本地来源的 `sourceDir`）。 */
export interface CatalogMarketEntry {
  id: string;
  kind: CatalogKind;
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  /** 兼容性阻止原因；空数组表示当前内核可安装。 */
  blocks: BlockReasonLike[];
}

/** 读取已安装组件的版本（文件系统指针），用于版本对比与求解。 */
export async function catalogInstalledVersion(
  kind: CatalogKind,
  id: string,
): Promise<string | null> {
  const dir = packageDir(kind, id);
  const manifestFile = path.join(dir, kind === 'plugin' ? 'manifest.json' : 'theme.json');
  try {
    const parsed = JSON.parse(await readFile(manifestFile, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** 某个 `(kind,id)` 在目录中的候选条目（按版本降序，剔除撤回）。 */
export function catalogEntriesFor(
  catalog: CatalogSnapshot,
  kind: CatalogKind,
  id: string,
): CatalogEntry[] {
  const source = catalogCandidateSources(catalog).find(
    (candidate) => candidate.kind === kind && candidate.id === id,
  );
  return (source?.manifests ?? []) as CatalogEntry[];
}

/**
 * 列出目录中某类组件的**最高版本**（每个 `(kind,id)` 一条），带上兼容性阻止原因，
 * 并并发读取磁盘上的已安装版本。这是市场列表页在「不请求 GitHub」前提下能展示的
 * 远程条目。
 */
export async function listCatalogMarketEntries(
  catalog: CatalogSnapshot,
  kind: CatalogKind,
  kernel: KernelCapabilities = kernelCapabilities(),
): Promise<Array<CatalogMarketEntry & { installedVersion: string | null }>> {
  const sources = catalogCandidateSources(catalog).filter((source) => source.kind === kind);
  return Promise.all(
    sources.map(async (source) => {
      const highest = (source.manifests as CatalogEntry[])[0];
      return {
        id: source.id,
        kind,
        name: highest?.name ?? source.id,
        version: highest?.version ?? '0.0.0',
        ...(highest?.description ? { description: highest.description } : {}),
        ...(highest?.publisher ? { publisher: highest.publisher } : {}),
        blocks: highest ? checkPackageCompatibility(highest, kernel) : [],
        installedVersion: await catalogInstalledVersion(kind, source.id),
      };
    }),
  ).then((entries) => entries.sort((a, b) => a.id.localeCompare(b.id)));
}

export interface PreparedCatalogInstall {
  kind: CatalogKind;
  id: string;
  version: string;
  publisher: string;
  keyId: string;
  upgraded: boolean;
  handle: StageHandle;
  /** 插件：已验证的 `PluginManifestFile`；主题：`ThemeManifest`。 */
  packageManifest: PluginManifestFile | ThemeManifest;
}

/**
 * 解析目标版本 → 下载验签 → 校验包体 → 原子暂存。返回**未提交**的句柄：调用方须在
 * 运行时 register/activate + DB 指针成功后 `commit()`，失败 `rollback()`（§7.6）。
 */
export async function prepareCatalogInstall(
  deps: CatalogInstallDeps,
  kind: CatalogKind,
  id: string,
): Promise<PreparedCatalogInstall> {
  const entries = catalogEntriesFor(deps.catalog, kind, id);
  if (entries.length === 0) {
    throw new CatalogMarketError(
      `${kind === 'plugin' ? '插件' : '主题'} ${id} 不在目录中`,
      [],
      'not_found',
    );
  }
  const currentVersion = await catalogInstalledVersion(kind, id);
  const installed: InstalledComponent | undefined =
    currentVersion !== null
      ? { kind, id, version: currentVersion, enabled: true, grantedPermissions: [] }
      : undefined;
  const selection = selectTargetVersion(
    { kind, id, manifests: entries },
    installed,
    kernelCapabilities(),
    { channel: deps.channel },
  );
  if (!selection.ok) {
    throw new CatalogMarketError(
      `${id} 没有可用版本：${selection.blocks.map((block) => block.detail).join('；')}`,
      selection.blocks,
      'blocked',
    );
  }
  const entry =
    entries.find((candidate) => candidate.version === selection.manifest.version) ??
    (selection.manifest as CatalogEntry);

  let fetched;
  try {
    fetched = await fetchCatalogPackage({
      catalog: deps.catalog,
      entry,
      keyring: deps.keyring,
      cache: deps.cache,
      ...(deps.token ? { token: deps.token } : {}),
      ...(deps.mirror ? { mirror: deps.mirror } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch (error) {
    // 信任归属/验签失败（CatalogConsumerError / PackageFetchError）不得降级为放行：
    // 统一转成市场可展示的拒绝，且**不**触碰活动目录。原始错误挂到 cause 上，
    // 让 `mapCatalogInstallError` 能细分错误码（限流/超限/验签/网络）。
    if (error instanceof CatalogMarketError) throw error;
    throw new CatalogMarketError(
      error instanceof Error ? error.message : String(error),
      [],
      'fetch',
      error,
    );
  }

  const entriesRecord: Record<string, Uint8Array> = {};
  for (const [name, data] of fetched.files) entriesRecord[name] = data;

  if (kind === 'plugin') {
    const { manifest, files } = assemblePluginFiles(entriesRecord);
    assertManifestMatches(manifest.id, manifest.version, id, entry.version);
    const handle = await packageManager.stageFiles('plugin', id, files, {
      prepareStage: async (stage) => {
        await mkdir(path.join(stage, 'dist'), { recursive: true });
      },
    });
    return {
      kind,
      id,
      version: manifest.version,
      publisher: fetched.publisher,
      keyId: fetched.keyId,
      upgraded: currentVersion !== null,
      handle,
      packageManifest: manifest,
    };
  }

  const { manifest, files } = assembleThemeFiles(entriesRecord);
  assertManifestMatches(manifest.id, manifest.version, id, entry.version);
  const handle = await packageManager.stageFiles('theme', id, files);
  return {
    kind,
    id,
    version: manifest.version,
    publisher: fetched.publisher,
    keyId: fetched.keyId,
    upgraded: currentVersion !== null,
    handle,
    packageManifest: manifest,
  };
}

/** 目录条目与包体清单必须一致，否则视为来源被篡改。 */
function assertManifestMatches(
  actualId: string,
  actualVersion: string,
  expectedId: string,
  expectedVersion: string,
): void {
  if (actualId !== expectedId || actualVersion !== expectedVersion) {
    throw new CatalogMarketError(
      `包体清单与目录不一致：目录 ${expectedId}@${expectedVersion}，包体 ${actualId}@${actualVersion}`,
      [],
      'mismatch',
    );
  }
}
