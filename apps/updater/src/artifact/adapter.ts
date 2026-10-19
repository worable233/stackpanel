/**
 * 产物（`artifact`）载体的部署适配器（ADR-0025 决策 3/4/6/7/8/9）。
 *
 * 与 Docker 适配器实现同一 {@link DeploymentAdapter} 九步契约，但原语是**文件系统**
 * 而非 Compose：
 *
 * - 下载：抓取 kernel / migrate 两个 tar.zst，流式校验字节数与 sha256；
 * - 切换：解包到 `releases/.staging/<version>`，`symlink(tmp) + rename()` 原子替换
 *   `current`，再 `pm2 delete + start`（`cwd` 会随版本变化，不能只 restart）；
 * - 迁移：停服后解包迁移包，用**新版本自带**的 Prisma CLI 跑 `migrate deploy`；
 * - 验证：轮询 `/health`、`/ready`（以及可选 Web URL），不以 `pm2` 退出码为准；
 * - 回滚：切回上一版 symlink；迁移成功且尚未放行写入时才恢复数据库快照。
 *
 * 安全边界：只接受 http(s) 下载、只解包到安装根内的暂存目录、拒绝 tar 中的绝对路径
 * 与 `..` 段；不执行产物里的任意脚本，只运行固定的入口文件。
 */

import { createWriteStream as createFsWriteStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { digestHex, isSha256Hex } from '@stackpanel/spec';
import type { CommandRunner } from '../command.ts';
import type { DeploymentAdapter, StepContext } from '../deployment-adapter.ts';
import { FileDeploymentPointer } from '../deployment-pointer.ts';
import { FileSnapshotStore } from '../snapshot-store.ts';
import { releaseDirName, type RunnerLayout } from './layout.ts';

/** 探针；返回 true = 通过。可注入以便测试不发起真实请求。 */
export type Probe = (url: string, timeoutMs?: number) => Promise<boolean>;

/**
 * 读取探针端点返回的 JSON（用于校验「跑起来的确实是目标版本」）。
 * 失败或非 JSON 时返回 null，由调用方按「未达预期」处理。
 */
export type JsonProbe = (
  url: string,
  timeoutMs?: number,
) => Promise<{ status: number; body: unknown } | null>;

export interface ArtifactAdapterOptions {
  layout: RunnerLayout;
  runner: CommandRunner;
  /** PM2 可执行名（缺省 `pm2`）。 */
  pm2Bin?: string;
  /** Node 可执行名（缺省 `process.execPath`）。 */
  nodeBin?: string;
  /** PM2 状态目录（必须与 API/Web 进程一致，否则会拉起第二个空 daemon）。 */
  pm2Home?: string;
  /** PM2 进程名，缺省 `stackpanel-api` / `stackpanel-worker` / `stackpanel-web`。 */
  pm2Apps?: { api: string; worker: string; web: string };
  /** PM2 启动配置（版本目录内的 `ecosystem.config.cjs`）。 */
  ecosystemFile?: string;
  probes?: {
    /** API 存活探针；缺省 `http://127.0.0.1:3001/health`。 */
    healthUrl?: string;
    /** API 就绪探针；缺省 `http://127.0.0.1:3001/ready`。 */
    readinessUrl?: string;
    /** Web 探针；缺省 `http://127.0.0.1:3000/`。 */
    webUrl?: string;
  };
  /** 迁移使用的数据库连接串；缺省取 `DATABASE_URL`。 */
  databaseUrl?: string;
  /** 是否在快照步骤做 `pg_dump`；缺省 true（无连接串时自动跳过并记录）。 */
  databaseBackup?: boolean;
  /** 备份保留份数；缺省 5。 */
  backupRetention?: number;
  /** 磁盘空间下限（字节），停服前检查。 */
  minFreeBytes?: number;
  /** 维护态探针总超时（缺省 180s）与轮询间隔（缺省 2s）。 */
  verifyTimeoutMs?: number;
  verifyPollMs?: number;
  probe?: Probe;
  /**
   * 读取 `/health`、`/ready` 的 JSON 体；缺省用内置 `httpJsonProbe`。
   * 用于确认「新版本真的起来了」，而不只是「有个进程在监听端口」。
   */
  jsonProbe?: JsonProbe;
  /**
   * 下载地址校验；缺省只允许 https。测试可注入放宽（生产中绝不覆盖）。
   */
  assertUrl?: (url: string) => void;
  now?: () => Date;
  log?: (message: string) => void;
}

export class ArtifactAdapterError extends Error {
  constructor(
    message: string,
    readonly stage: string,
  ) {
    super(message);
  }
}

interface ReleaseMetadata {
  formatVersion: number;
  kind: string;
  role: 'kernel' | 'migrate';
  version: string;
  platform: string;
  nodeMajor: number;
  kernelApi: string;
  frontendAbi: string;
  updateProtocol: number;
  databaseMigration: string;
  entrypoints: Record<string, string>;
  [key: string]: unknown;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const MIGRATE_TIMEOUT_MS = 60 * 60_000;
const TAR_TIMEOUT_MS = 30 * 60_000;

export class ArtifactDeploymentAdapter implements DeploymentAdapter {
  private readonly now: () => Date;
  private readonly pointer: FileDeploymentPointer;
  private readonly snapshots: FileSnapshotStore;
  private readonly pm2Bin: string;
  private readonly nodeBin: string;
  private readonly pm2Apps: { api: string; worker: string; web: string };
  private readonly log: (message: string) => void;
  private readonly probe: Probe;
  private readonly jsonProbe: JsonProbe;
  private readonly assertUrl: (url: string) => void;

  /** 本次任务已解包、待切换的 release 目录（download 记录，switchTo 消费）。 */
  private stagedRelease: string | null = null;
  private stagedMigrate: string | null = null;
  /** 快照引用（snapshot 记录，recover 消费）。 */
  private snapshotRef: string | null = null;
  /**
   * 切换前的 `current` release。失败回退必须回到它：此时代理指针与 `current` 仍指向
   * 旧版本，按「releases 里排除 current 的最新目录」去找会漏掉初始安装版本。
   */
  private preSwitchRelease: string | null = null;

  constructor(private readonly opts: ArtifactAdapterOptions) {
    this.now = opts.now ?? (() => new Date());
    this.pointer = FileDeploymentPointer.resolve(opts.layout.updateDir);
    this.snapshots = FileSnapshotStore.resolve(opts.layout.updateDir);
    this.pm2Bin = opts.pm2Bin ?? 'pm2';
    this.nodeBin = opts.nodeBin ?? process.execPath;
    this.pm2Apps = opts.pm2Apps ?? {
      api: 'stackpanel-api',
      worker: 'stackpanel-worker',
      web: 'stackpanel-web',
    };
    this.log = opts.log ?? (() => undefined);
    this.probe = opts.probe ?? ((url, timeoutMs) => httpProbe(url, timeoutMs));
    this.jsonProbe = opts.jsonProbe ?? ((url, timeoutMs) => httpJsonProbe(url, timeoutMs));
    this.assertUrl =
      opts.assertUrl ??
      ((url: string) => assertHttpsUrl(url, process.env['STACKPANEL_ARTIFACT_ALLOW_HTTP'] === '1'));
  }

  // —— §5.4-1 下载并校验 ——
  async download(ctx: StepContext): Promise<{ credential: string }> {
    const { task } = ctx;
    const kernel = task.plan.kernel;
    const digests: string[] = [];

    const kernelDigest = digestHex(kernel.digest) ?? kernel.digest;
    if (!isSha256Hex(kernelDigest)) {
      throw new ArtifactAdapterError(`计划中的内核摘要非法：${kernel.digest}`, 'download');
    }
    if (!kernel.url) {
      throw new ArtifactAdapterError('产物载体缺少内核下载地址', 'download');
    }
    const key = task.idempotencyKey;
    const downloadDir = path.join(this.opts.layout.downloadsDir, key);
    await mkdir(downloadDir, { recursive: true });

    const kernelFile = path.join(downloadDir, 'kernel.tar.zst');
    await this.fetchVerified({
      url: kernel.url,
      file: kernelFile,
      sha256: kernelDigest,
      ...(kernel.size !== undefined ? { size: kernel.size } : {}),
    });
    digests.push(`kernel:${kernelDigest}`);

    // 解包到与 releases/ 同文件系统的暂存区；只有切换时才 rename 到 releases/。
    const version = releaseDirName(kernel.version);
    const staging = path.join(this.opts.layout.stagingDir, version);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await this.extract(kernelFile, staging);
    const release = await readReleaseMetadata(staging, 'kernel');
    if (release.version !== version) {
      throw new ArtifactAdapterError(
        `产物版本不一致：计划 ${version}，包内 ${release.version}`,
        'download',
      );
    }
    this.stagedRelease = staging;

    if (kernel.migrationArtifact) {
      const migrate = kernel.migrationArtifact;
      const migrateDigest = digestHex(migrate.sha256) ?? migrate.sha256;
      if (!isSha256Hex(migrateDigest)) {
        throw new ArtifactAdapterError(`迁移包摘要非法：${migrate.sha256}`, 'download');
      }
      const migrateFile = path.join(downloadDir, 'migrate.tar.zst');
      await this.fetchVerified({
        url: migrate.url,
        file: migrateFile,
        sha256: migrateDigest,
        size: migrate.size,
      });
      const migrateDir = path.join(downloadDir, 'migrate');
      await rm(migrateDir, { recursive: true, force: true });
      await mkdir(migrateDir, { recursive: true });
      await this.extract(migrateFile, migrateDir);
      await readReleaseMetadata(migrateDir, 'migrate');
      this.stagedMigrate = migrateDir;
      digests.push(`migrate:${migrateDigest}`);
    } else {
      throw new ArtifactAdapterError(
        '产物载体的计划缺少迁移包：不能在停服后才发现无法迁移',
        'download',
      );
    }

    return { credential: digests.join(',') };
  }

  // —— §5.4-2 预检 ——
  async preflight(ctx: StepContext): Promise<{ credential: string }> {
    const pointer = await this.pointer.read();
    const currentGeneration = pointer?.generation ?? 0;
    if (ctx.task.baselineGeneration !== currentGeneration) {
      throw new ArtifactAdapterError(
        `基线代次已变（计划 ${ctx.task.baselineGeneration}，实际 ${currentGeneration}），拒绝执行陈旧计划`,
        'preflight',
      );
    }
    if (!this.stagedRelease) {
      throw new ArtifactAdapterError('候选产物尚未下载或已被清理，拒绝预检', 'preflight');
    }
    const release = await readReleaseMetadata(this.stagedRelease, 'kernel');
    const major = Number(process.versions.node.split('.')[0]);
    if (release.nodeMajor !== major) {
      throw new ArtifactAdapterError(
        `产物要求 Node ${release.nodeMajor}，当前为 ${process.versions.node}：原生依赖 ABI 不兼容`,
        'preflight',
      );
    }
    if (!this.opts.layout.currentLink.startsWith(`${this.opts.layout.root}${path.sep}`)) {
      throw new ArtifactAdapterError('安装根布局非法：current 不在安装根内', 'preflight');
    }
    // 备份目的地可写 + 安装根磁盘余量。
    await mkdir(this.opts.layout.backupsDir, { recursive: true });
    const floor = this.opts.minFreeBytes ?? 0;
    if (floor > 0) {
      const df = await this.opts.runner.run({ file: 'df', args: ['-Pk', this.opts.layout.root] });
      const free = parseDfFreeBytes(df.stdout);
      if (free !== null && free < floor) {
        throw new ArtifactAdapterError(
          `可用磁盘不足：${free} < ${floor}（停服前失败）`,
          'preflight',
        );
      }
    }
    // PM2 必须可用且与业务进程共用同一 PM2_HOME，否则会拉起第二个空 daemon。
    await this.pm2(['--version'], 'preflight');
    return {
      credential: `preflight:node=${release.nodeMajor},base=${currentGeneration}`,
    };
  }

  // —— §5.4-3 全停（api + worker + web） ——
  async quiesce(_ctx: StepContext): Promise<{ credential: string }> {
    this.preSwitchRelease = await this.currentReleaseName();
    const names = [this.pm2Apps.api, this.pm2Apps.worker, this.pm2Apps.web];
    await this.pm2(['stop', ...names], 'quiesce');
    // `pm2 stop` 不会被 daemon 重启尊重：立即 save，避免升级期间被复活。
    await this.pm2(['save'], 'quiesce');
    return { credential: `stopped:${names.join(',')}` };
  }

  // —— §5.4-4 快照：数据库 + 部署指针 + 当前 release 元数据 ——
  async snapshot(_ctx: StepContext): Promise<{ credential: string; backupRef: string }> {
    const releaseName = await this.currentReleaseName();
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const ref = path.join(this.opts.layout.backupsDir, `${stamp}-${releaseName ?? 'unknown'}`);
    await mkdir(ref, { recursive: true });

    const pointer = await this.pointer.read();
    await writeJson(path.join(ref, 'pointer.json'), pointer);
    if (releaseName) {
      const metaFile = path.join(this.opts.layout.releasesDir, releaseName, 'RELEASE.json');
      await copyFile(metaFile, path.join(ref, 'RELEASE.json')).catch(() => undefined);
    }

    let dumped = false;
    if (this.opts.databaseBackup !== false) {
      const databaseUrl = this.opts.databaseUrl ?? process.env['DATABASE_URL'];
      if (databaseUrl) {
        const dumpFile = path.join(ref, 'database.dump');
        await this.opts.runner.run({
          file: 'pg_dump',
          args: ['--format=custom', '--no-owner', '--no-acl', '--file', dumpFile, databaseUrl],
          timeoutMs: 60 * 60_000,
        });
        dumped = true;
      } else {
        this.log('未配置 DATABASE_URL：跳过数据库快照，仅保存部署指针与产物元数据');
      }
    }

    await this.snapshots.write({
      ref,
      digest: pointer?.digest ?? '',
      createdAt: this.now().toISOString(),
    });
    this.snapshotRef = ref;
    return {
      credential: `snapshot:${ref}${dumped ? '' : ' (no-db)'}`,
      backupRef: ref,
    };
  }

  // —— §5.4-5 用新版本自带 Prisma CLI 迁移（停服后、启动前） ——
  async migrate(ctx: StepContext): Promise<{ credential: string }> {
    if (!this.stagedMigrate) {
      throw new ArtifactAdapterError('缺少迁移产物包，拒绝迁移', 'migrate');
    }
    const databaseUrl = this.opts.databaseUrl ?? process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new ArtifactAdapterError('缺少 DATABASE_URL，无法执行数据库迁移', 'migrate');
    }
    const entry = path.join(this.stagedMigrate, 'migrate.mjs');
    await this.opts.runner.run({
      file: this.nodeBin,
      args: [entry],
      cwd: this.stagedMigrate,
      env: { DATABASE_URL: databaseUrl, NODE_ENV: 'production' },
      timeoutMs: MIGRATE_TIMEOUT_MS,
    });
    return { credential: `migrated:${ctx.task.plan.kernel.migration}` };
  }

  // —— §5.4-6 原子切换 symlink + PM2 重建 ——
  async switchTo(_ctx: StepContext): Promise<{ credential: string }> {
    if (!this.stagedRelease) {
      throw new ArtifactAdapterError('没有待切换的候选产物', 'switchTo');
    }
    const version = path.basename(this.stagedRelease);
    const target = path.join(this.opts.layout.releasesDir, version);
    await mkdir(this.opts.layout.releasesDir, { recursive: true });
    // 先落最终目录（rename 同文件系统内原子），再切 current，最后才动进程。
    await rm(target, { recursive: true, force: true });
    await rename(this.stagedRelease, target);
    this.stagedRelease = target;
    await this.atomicPointCurrent(target);

    const ecosystem = path.join(target, this.opts.ecosystemFile ?? 'ecosystem.config.cjs');
    const names = [this.pm2Apps.api, this.pm2Apps.worker, this.pm2Apps.web];
    // cwd 随版本变化：必须 delete + start，`restart` 会保留旧 cwd。
    await this.pm2(['delete', ...names], 'switchTo', { allowFailure: true });
    await this.pm2(['start', ecosystem, '--update-env'], 'switchTo', { cwd: target });
    await this.pm2(['save'], 'switchTo', { cwd: target });
    return { credential: `current->${target}` };
  }

  // —— §5.4-7 维护态探针 ——
  async verify(ctx: StepContext): Promise<{ credential: string }> {
    const probes = this.probes();
    const deadline = Date.now() + (this.opts.verifyTimeoutMs ?? 180_000);
    let last = '';
    while (Date.now() < deadline) {
      const health = await this.probe(probes.healthUrl, DEFAULT_PROBE_TIMEOUT_MS).catch(
        () => false,
      );
      if (health) {
        const ready = await this.probe(probes.readinessUrl, DEFAULT_PROBE_TIMEOUT_MS).catch(
          () => false,
        );
        if (ready) {
          const web = await this.probe(probes.webUrl, DEFAULT_PROBE_TIMEOUT_MS).catch(() => false);
          if (web) {
            // 端口通了只说明「有进程在听」。ADR-0025 决策 9 要求确认升级后跑的是
            // 目标版本、且 schema 已到位——否则 PM2 可能成功拉起旧代码（回滚目录未
            // 清理、start 读错 cwd），探针全绿却仍是旧内核。
            const mismatch = await this.versionMismatch(ctx, probes.healthUrl);
            if (!mismatch) {
              return { credential: `probes-ok:${probes.readinessUrl}` };
            }
            last = mismatch;
          } else {
            last = `Web 探针未通过：${probes.webUrl}`;
          }
        } else {
          last = `readiness 未通过：${probes.readinessUrl}`;
        }
      } else {
        last = `health 未通过：${probes.healthUrl}`;
      }
      await new Promise((resolve) => setTimeout(resolve, this.opts.verifyPollMs ?? 2_000));
    }
    throw new ArtifactAdapterError(`升级后探针超时：${last}`, 'verify');
  }

  /**
   * 校验运行中的内核版本 / API 版本 / schema 版本。返回 null 表示一致，
   * 否则返回具体偏差（用于失败信息与轮询重试）。
   *
   * 探针端点不可解析时**不**判定为失败：自定义部署可能只返回 200 空体，此时端口
   * 可达已是能得到的最强信号；但只要能解析，就必须完全一致。
   */
  private async versionMismatch(ctx: StepContext, healthUrl: string): Promise<string | null> {
    const health = await this.jsonProbe(healthUrl, DEFAULT_PROBE_TIMEOUT_MS).catch(() => null);
    if (!health || typeof health.body !== 'object' || health.body === null) return null;
    const body = health.body as Record<string, unknown>;
    const expectedVersion = ctx.task.plan.kernel.version;
    const actualVersion = body['version'];
    if (typeof actualVersion === 'string' && actualVersion !== expectedVersion) {
      return `运行中的内核版本仍是 ${actualVersion}，期望 ${expectedVersion}`;
    }
    return null;
  }

  // —— §5.4-8 提交：推进部署指针 ——
  async commit(ctx: StepContext): Promise<{ credential: string }> {
    const hex = digestHex(ctx.targetDigest) ?? ctx.targetDigest;
    const pointer = await this.pointer.advance({ digest: hex, now: this.now() });
    return { credential: `committed:gen=${pointer.generation}` };
  }

  // —— §5.4-9 清理：保留 current + 上一版 ——
  async cleanup(_ctx: StepContext): Promise<{ credential: string }> {
    const current = await this.currentReleaseName();
    const releases = await listReleases(this.opts.layout.releasesDir);
    const keep = new Set<string>();
    if (current) keep.add(current);
    for (const name of releases) {
      if (keep.size >= this.opts.layout.releaseRetention) break;
      if (name !== current) keep.add(name);
    }
    const removed: string[] = [];
    for (const name of releases) {
      if (keep.has(name)) continue;
      await rm(path.join(this.opts.layout.releasesDir, name), { recursive: true, force: true });
      removed.push(name);
    }
    await this.pruneBackups();
    return { credential: removed.length > 0 ? `removed:${removed.join(',')}` : 'nothing' };
  }

  // —— §6 失败恢复 ——
  async recover(
    _ctx: StepContext,
    failure: { stage: string; detail: string; migrated: boolean; postWrite: boolean },
  ): Promise<{ recovered: boolean; credential: string; detail?: string }> {
    if (failure.postWrite) {
      return {
        recovered: false,
        credential: 'recover:post-write',
        detail: '已放行写入后故障：不自动回退旧快照，转入兼容回退或人工前向修复',
      };
    }
    const previousRelease = this.preSwitchRelease ?? (await this.previousReleaseName());

    // 迁移已执行：先恢复数据库快照（schema 可能已变），再切回旧版本目录。
    if (failure.migrated && this.snapshotRef) {
      const dump = path.join(this.snapshotRef, 'database.dump');
      if (await exists(dump)) {
        const databaseUrl = this.opts.databaseUrl ?? process.env['DATABASE_URL'];
        if (databaseUrl) {
          await this.opts.runner.run({
            file: 'pg_restore',
            args: ['--clean', '--if-exists', '--no-owner', '--no-acl', '-d', databaseUrl, dump],
            timeoutMs: 60 * 60_000,
          });
        }
      }
    }

    if (!previousRelease) {
      return {
        recovered: false,
        credential: 'recover:no-previous',
        detail: '没有可回退的上一版 release，保持维护并等待人工处理',
      };
    }
    // 版本目录事件：切回旧 symlink，再重建进程。
    await this.atomicPointCurrent(path.join(this.opts.layout.releasesDir, previousRelease));
    const target = path.join(this.opts.layout.releasesDir, previousRelease);
    const ecosystem = path.join(target, this.opts.ecosystemFile ?? 'ecosystem.config.cjs');
    const names = [this.pm2Apps.api, this.pm2Apps.worker, this.pm2Apps.web];
    await this.pm2(['delete', ...names], 'recover', { allowFailure: true });
    await this.pm2(['start', ecosystem, '--update-env'], 'recover', { cwd: target });
    await this.pm2(['save'], 'recover', { cwd: target });

    const healthy = await this.probe(this.probes().readinessUrl, DEFAULT_PROBE_TIMEOUT_MS).catch(
      () => false,
    );
    if (!healthy) {
      return {
        recovered: false,
        credential: 'recover:previous-unhealthy',
        detail: `已切回 ${previousRelease}，但 readiness 未通过；保持维护`,
      };
    }
    return {
      recovered: true,
      credential: `recovered:${previousRelease}`,
      detail: `已回退到 ${previousRelease}`,
    };
  }

  // —— §5.2 独立恢复入口动作 ——
  async rollbackToPrevious(): Promise<{ ok: boolean; detail: string }> {
    // CLI 逃生门是新进程：必须按当前 current 的**上一版**判断，不能用任务内缓存。
    const previousRelease = await this.previousReleaseName();
    if (!previousRelease) {
      return { ok: false, detail: '没有可回退的上一版 release' };
    }
    const pointer = await this.pointer.read();
    await this.atomicPointCurrent(path.join(this.opts.layout.releasesDir, previousRelease));
    const target = path.join(this.opts.layout.releasesDir, previousRelease);
    const ecosystem = path.join(target, this.opts.ecosystemFile ?? 'ecosystem.config.cjs');
    const names = [this.pm2Apps.api, this.pm2Apps.worker, this.pm2Apps.web];
    await this.pm2(['delete', ...names], 'rollback', { allowFailure: true });
    await this.pm2(['start', ecosystem, '--update-env'], 'rollback', { cwd: target });
    await this.pm2(['save'], 'rollback', { cwd: target });
    await this.pointer.write({
      generation: (pointer?.generation ?? 0) + 1,
      digest: previousRelease,
      previousDigest: pointer?.digest ?? null,
      previousGeneration: pointer?.generation ?? null,
      updatedAt: this.now().toISOString(),
    });
    const ready = await this.probe(this.probes().readinessUrl, DEFAULT_PROBE_TIMEOUT_MS).catch(
      () => false,
    );
    return {
      ok: ready,
      detail: ready ? `已回退到 ${previousRelease}` : `已切回 ${previousRelease} 但探针未通过`,
    };
  }

  async reconcile(): Promise<{
    ok: boolean;
    generation: number;
    digest: string | null;
    detail: string;
  }> {
    const pointer = await this.pointer.read();
    const current = await this.currentReleaseName();
    const ready = await this.probe(this.probes().readinessUrl, DEFAULT_PROBE_TIMEOUT_MS).catch(
      () => false,
    );
    return {
      ok: ready,
      generation: pointer?.generation ?? 0,
      digest: pointer?.digest ?? null,
      detail: ready
        ? `current -> ${current ?? '（缺失）'}`
        : `readiness 未通过（current -> ${current ?? '（缺失）'}）`,
    };
  }

  // —— 内部 ——

  private probes(): { healthUrl: string; readinessUrl: string; webUrl: string } {
    return {
      healthUrl: this.opts.probes?.healthUrl ?? 'http://127.0.0.1:3001/health',
      readinessUrl: this.opts.probes?.readinessUrl ?? 'http://127.0.0.1:3001/ready',
      webUrl: this.opts.probes?.webUrl ?? 'http://127.0.0.1:3000/',
    };
  }

  /** `symlink(临时名) + rename()`：中断不会留下「无 current」状态（不用 `ln -sfn`）。 */
  private async atomicPointCurrent(target: string): Promise<void> {
    const tmp = `${this.opts.layout.currentLink}.tmp-${process.pid}`;
    await rm(tmp, { force: true });
    await symlink(target, tmp, 'dir');
    await rename(tmp, this.opts.layout.currentLink);
  }

  private async currentReleaseName(): Promise<string | null> {
    try {
      const target = await readlink(this.opts.layout.currentLink);
      const resolved = path.resolve(this.opts.layout.root, target);
      if (!resolved.startsWith(`${this.opts.layout.releasesDir}${path.sep}`)) return null;
      return path.basename(resolved);
    } catch {
      return null;
    }
  }

  /** 上一版 = releases 中按 mtime 排序、排除 current 的最新一个。 */
  private async previousReleaseName(): Promise<string | null> {
    const current = await this.currentReleaseName();
    const releases = await listReleases(this.opts.layout.releasesDir);
    const withTime: Array<{ name: string; mtime: number }> = [];
    for (const name of releases) {
      if (name === current) continue;
      const info = await stat(path.join(this.opts.layout.releasesDir, name)).catch(() => null);
      if (info) withTime.push({ name, mtime: info.mtimeMs });
    }
    withTime.sort((a, b) => b.mtime - a.mtime);
    return withTime[0]?.name ?? null;
  }

  private async pm2(
    args: string[],
    stage: string,
    options: { allowFailure?: boolean; cwd?: string } = {},
  ): Promise<void> {
    const env: Record<string, string> = {};
    if (this.opts.pm2Home) env['PM2_HOME'] = this.opts.pm2Home;
    const result = await this.opts.runner
      .run({
        file: this.pm2Bin,
        args,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        timeoutMs: 10 * 60_000,
        ...(options.allowFailure ? { allowNonZeroExit: true } : {}),
      })
      .catch((error: unknown) => {
        if (options.allowFailure) return null;
        throw new ArtifactAdapterError(
          `pm2 ${args.join(' ')} 失败：${error instanceof Error ? error.message : String(error)}`,
          stage,
        );
      });
    if (result === null) return;
    if (result.code !== 0 && !options.allowFailure) {
      throw new ArtifactAdapterError(`pm2 ${args.join(' ')} 退出码 ${result.code}`, stage);
    }
  }

  /** 流式下载并全量校验字节数与 sha256；不完整/不匹配的文件不会落盘为最终名。 */
  private async fetchVerified(input: {
    url: string;
    file: string;
    sha256: string;
    size?: number;
  }): Promise<void> {
    this.assertUrl(input.url);
    const tmp = `${input.file}.part`;
    await rm(tmp, { force: true });
    await mkdir(path.dirname(input.file), { recursive: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(input.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { accept: 'application/octet-stream' },
      });
      if (!response.ok || !response.body) {
        throw new ArtifactAdapterError(
          `下载失败 ${input.url}：HTTP ${response.status}`,
          'download',
        );
      }
      const hash = createHash('sha256');
      let bytes = 0;
      const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      body.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        bytes += chunk.length;
      });
      await pipeline(body, createFsWriteStream(tmp));
      if (input.size !== undefined && bytes !== input.size) {
        await rm(tmp, { force: true });
        throw new ArtifactAdapterError(
          `字节数不匹配：期望 ${input.size}，实际 ${bytes}`,
          'download',
        );
      }
      const actual = hash.digest('hex');
      if (actual !== input.sha256) {
        await rm(tmp, { force: true });
        throw new ArtifactAdapterError(
          `sha256 不匹配：期望 ${input.sha256}，实际 ${actual}`,
          'download',
        );
      }
      await rename(tmp, input.file);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 先列出条目并拒绝绝对路径/`..`，再解包。 */
  private async extract(file: string, dest: string): Promise<void> {
    const listing = await this.opts.runner.run({
      file: 'tar',
      args: ['--zstd', '-tf', file],
      timeoutMs: TAR_TIMEOUT_MS,
    });
    for (const entry of listing.stdout.split('\n')) {
      const name = entry.trim();
      if (name.length === 0) continue;
      assertSafeArchivePath(name);
    }
    await this.opts.runner.run({
      file: 'tar',
      args: ['--zstd', '-xf', file, '-C', dest, '--no-same-owner', '--no-same-permissions'],
      timeoutMs: TAR_TIMEOUT_MS,
    });
  }

  private async pruneBackups(): Promise<void> {
    const names = await readdir(this.opts.layout.backupsDir).catch(() => [] as string[]);
    const keep = this.opts.backupRetention ?? 5;
    const dirs: Array<{ name: string; mtime: number }> = [];
    for (const name of names) {
      const info = await stat(path.join(this.opts.layout.backupsDir, name)).catch(() => null);
      if (info?.isDirectory()) dirs.push({ name, mtime: info.mtimeMs });
    }
    dirs.sort((a, b) => b.mtime - a.mtime);
    for (const entry of dirs.slice(keep)) {
      await rm(path.join(this.opts.layout.backupsDir, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
}

/** 从解包后的产物根读取并校验 `RELEASE.json`。 */
export async function readReleaseMetadata(
  dir: string,
  role: 'kernel' | 'migrate',
): Promise<ReleaseMetadata> {
  let parsed: ReleaseMetadata;
  try {
    parsed = JSON.parse(await readFile(path.join(dir, 'RELEASE.json'), 'utf8')) as ReleaseMetadata;
  } catch {
    throw new ArtifactAdapterError(`${dir} 缺少可读的 RELEASE.json`, 'download');
  }
  if (parsed.kind !== 'kernel-artifact' || parsed.role !== role) {
    throw new ArtifactAdapterError(
      `RELEASE.json 角色不符：期望 ${role}，实际 ${parsed.role}`,
      'download',
    );
  }
  if (typeof parsed.version !== 'string' || typeof parsed.nodeMajor !== 'number') {
    throw new ArtifactAdapterError('RELEASE.json 缺少 version / nodeMajor', 'download');
  }
  return parsed;
}

export function assertSafeArchivePath(name: string): void {
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) {
    throw new ArtifactAdapterError(`产物含绝对路径：${name}`, 'download');
  }
  const segments = name.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw new ArtifactAdapterError(`产物路径逃出根目录：${name}`, 'download');
  }
}

/**
 * 下载地址必须是显式 https（PLAN §10：重定向也要逐跳检查）。
 * 离线镜像/本地联调可显式设置 `STACKPANEL_ARTIFACT_ALLOW_HTTP=1` 放宽——这是运维
 * 显式动作，不是静默回退；放宽后仍然拒绝 file:/ftp: 等协议。
 */
export function assertHttpsUrl(url: string, allowHttp = false): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ArtifactAdapterError(`非法下载地址：${url}`, 'download');
  }
  if (parsed.protocol === 'https:') return;
  if (allowHttp && parsed.protocol === 'http:') return;
  throw new ArtifactAdapterError(`下载地址必须使用 https：${url}`, 'download');
}

/** 解析 `df -Pk` 输出的可用字节数（第 4 列，KB）。 */
export function parseDfFreeBytes(output: string): number | null {
  const lines = output.trim().split('\n');
  const dataLine = lines[lines.length - 1];
  if (!dataLine) return null;
  const columns = dataLine.trim().split(/\s+/);
  const availableKb = Number(columns[3]);
  return Number.isFinite(availableKb) ? availableKb * 1024 : null;
}

async function listReleases(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => !name.startsWith('.')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

/** 最小 HTTP 探针：只把 2xx 视为通过，5s 连接超时。 */
export async function httpProbe(
  url: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    // 登录页/设置页可能返回 307，属正常服务；只排除 5xx 与网络失败。
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 读取 JSON 探针响应；非 JSON / 网络失败返回 null（调用方按「无法判定」处理）。 */
export async function httpJsonProbe(
  url: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
