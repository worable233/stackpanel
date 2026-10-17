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
  type BlockReasonLike,
  type CatalogEntry,
  type CatalogSnapshot,
  type InstalledComponent,
  type Keyring,
  type KernelCapabilities,
} from '@stackpanel/spec';
import { catalogCandidateSources, fetchCatalogPackage } from '../distribution/catalog-consumer.ts';
import type { SourceCache } from '../distribution/index.ts';
import { packageManager, packageDir, type StageHandle } from '../packages/index.ts';
import { kernelCapabilities } from '../distribution/kernel-capabilities.ts';
import { assemblePluginFiles, type PluginManifestFile } from './plugins.ts';
import { assembleThemeFiles, type ThemeManifest } from './themes.ts';

export class CatalogMarketError extends Error {
  constructor(
    message: string,
    readonly blocks: BlockReasonLike[] = [],
  ) {
    super(message);
  }
}

/** 远程目录安装所需的、可注入的依赖集合。 */
export interface CatalogInstallDeps {
  catalog: CatalogSnapshot;
  keyring: Keyring;
  cache: SourceCache;
  channel: 'stable' | 'beta';
  token?: string;
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
    throw new CatalogMarketError(`${kind === 'plugin' ? '插件' : '主题'} ${id} 不在目录中`);
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
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch (error) {
    // 信任归属/验签失败（CatalogConsumerError / PackageFetchError）不得降级为放行：
    // 统一转成市场可展示的拒绝，且**不**触碰活动目录。
    if (error instanceof CatalogMarketError) throw error;
    throw new CatalogMarketError(error instanceof Error ? error.message : String(error));
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
    );
  }
}
