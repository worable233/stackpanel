/**
 * Docker/Compose 部署适配器（PLAN-github-distribution-and-updates §5.1、§5.4）。
 *
 * 把 {@link DeploymentAdapter} 的九步落到**绑定的 Compose project** 上。真实实现只
 * 通过注入的 {@link CommandRunner} 调用镜像预置的 docker/compose/pg 客户端，因此：
 * - 生产用 {@link SpawnCommandRunner}；
 * - 测试注入假 runner，覆盖成功/失败/超时分支而**不碰真实 Docker**。
 *
 * 所有切换都用「镜像环境变量 + `up -d`」把 api/worker/web 拉到**同一 release 集合**
 * （§5.4-6），只做停写维护切换，不承诺零停机。数据目录/密钥外置，不被新镜像覆盖。
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { digestHex } from '@stackpanel/spec';
import type { CommandRunner } from './command.ts';
import type { ComposeProjectConfig } from './compose-config.ts';
import { FileDeploymentPointer } from './deployment-pointer.ts';
import { FileSnapshotStore } from './snapshot-store.ts';
import type { DeploymentAdapter, StepContext } from './deployment-adapter.ts';
import type { SelfUpdateAdapter } from './self-update-executor.ts';

/** HTTP 探针（可注入，测试不发起真实请求）。返回 true = 通过。 */
export type Probe = (url: string, timeoutMs?: number) => Promise<boolean>;

/** 读取探针端点的 JSON 体（用于确认跑起来的确实是目标版本）。 */
export type JsonProbe = (
  url: string,
  timeoutMs?: number,
) => Promise<{ status: number; body: unknown } | null>;

export interface ComposeAdapterOptions {
  config: ComposeProjectConfig;
  runner: CommandRunner;
  /** updater 独立持久卷根（快照/备份/候选）。 */
  stateDir: string;
  pointer?: FileDeploymentPointer;
  /** 快照引用存储；缺省落在 stateDir。 */
  snapshots?: FileSnapshotStore;
  /** 探针实现；缺省走全局 fetch。 */
  probe?: Probe;
  /** 读取 `/health` JSON 体；缺省走全局 fetch。 */
  jsonProbe?: JsonProbe;
  /** 时钟（测试）。 */
  now?: () => Date;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export class DeploymentAdapterError extends Error {
  constructor(
    message: string,
    readonly stage: string,
    readonly migrated = false,
  ) {
    super(message);
  }
}

export class ComposeDeploymentAdapter implements DeploymentAdapter {
  private readonly config: ComposeProjectConfig;
  private readonly runner: CommandRunner;
  private readonly stateDir: string;
  private readonly pointer: FileDeploymentPointer;
  private readonly snapshots: FileSnapshotStore;
  private readonly probe: Probe;
  private readonly jsonProbe: JsonProbe;
  private readonly now: () => Date;

  constructor(options: ComposeAdapterOptions) {
    this.config = options.config;
    this.runner = options.runner;
    this.stateDir = options.stateDir;
    this.pointer = options.pointer ?? FileDeploymentPointer.resolve(options.stateDir);
    this.snapshots = options.snapshots ?? FileSnapshotStore.resolve(options.stateDir);
    this.probe = options.probe ?? defaultProbe;
    this.jsonProbe = options.jsonProbe ?? defaultJsonProbe;
    this.now = options.now ?? (() => new Date());
  }

  /** 目标镜像的完整 `repo@sha256:...` 引用。 */
  private targetImage(ctx: StepContext): string {
    return `${this.config.imageRepository}@${normalizeDigest(ctx.targetDigest)}`;
  }

  private backupDir(): string {
    return this.config.backupDir ?? path.join(this.stateDir, 'backups');
  }

  /** 组装 `docker compose` 基础参数。 */
  private compose(args: string[]): { file: string; args: string[] } {
    const files = this.config.composeFiles.flatMap((f) => ['-f', f]);
    return {
      file: 'docker',
      args: ['compose', '-p', this.config.projectName, ...files, ...args],
    };
  }

  private async composeRun(
    args: string[],
    opts: {
      env?: Record<string, string>;
      allowNonZeroExit?: boolean;
      timeoutMs?: number;
      stdoutFile?: string;
      stdinFile?: string;
    } = {},
  ): Promise<string> {
    const { file, args: full } = this.compose(args);
    const result = await this.runner.run({
      file,
      args: full,
      cwd: this.config.projectDir,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.allowNonZeroExit ? { allowNonZeroExit: true } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.stdoutFile ? { stdoutFile: opts.stdoutFile } : {}),
      ...(opts.stdinFile ? { stdinFile: opts.stdinFile } : {}),
    });
    return result.stdout;
  }

  // —— §5.4-1 下载候选镜像并校验 ——
  async download(ctx: StepContext): Promise<{ credential: string }> {
    const image = this.targetImage(ctx);
    await this.runner.run({
      file: 'docker',
      args: ['pull', image],
      cwd: this.config.projectDir,
      timeoutMs: 30 * 60_000,
    });
    // 校验本地确实存在该 digest（pull 成功不等于 manifest 命中预期）。
    const inspect = await this.runner.run({
      file: 'docker',
      args: ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image],
    });
    const digest = inspect.stdout.trim();
    if (!digest.includes(normalizeDigest(ctx.targetDigest))) {
      throw new DeploymentAdapterError(
        `下载后镜像摘要不匹配：期望 ${ctx.targetDigest}，实际 ${digest || '未知'}`,
        'download',
      );
    }
    return { credential: digest };
  }

  // —— §5.4-2 预检 ——
  async preflight(ctx: StepContext): Promise<{ credential: string }> {
    const pointer = await this.pointer.read();
    const currentGeneration = pointer?.generation ?? 0;
    if (ctx.task.baselineGeneration !== currentGeneration) {
      throw new DeploymentAdapterError(
        `基线代次已变（计划 ${ctx.task.baselineGeneration}，实际 ${currentGeneration}），拒绝执行陈旧计划`,
        'preflight',
      );
    }
    // DB 可达。
    await this.runner.run({
      file: 'docker',
      args: [
        'compose',
        '-p',
        this.config.projectName,
        ...this.config.composeFiles.flatMap((f) => ['-f', f]),
        'exec',
        '-T',
        this.config.database.service,
        'pg_isready',
        '-U',
        this.config.database.user,
        '-d',
        this.config.database.name,
      ],
      cwd: this.config.projectDir,
      timeoutMs: 30_000,
    });
    // 备份目的地可写。
    const backupDir = this.backupDir();
    await mkdir(backupDir, { recursive: true });
    // 磁盘空间。
    if (this.config.minFreeBytes && this.config.minFreeBytes > 0) {
      const df = await this.runner.run({
        file: 'df',
        args: ['-Pk', this.config.projectDir],
      });
      const freeBytes = parseDfFreeBytes(df.stdout);
      if (freeBytes !== null && freeBytes < this.config.minFreeBytes) {
        throw new DeploymentAdapterError(
          `可用磁盘不足：${freeBytes} < ${this.config.minFreeBytes}`,
          'preflight',
        );
      }
    }
    return { credential: `preflight:gen=${currentGeneration}` };
  }

  // —— §5.4-3 进入维护 ——
  async quiesce(_ctx: StepContext): Promise<{ credential: string }> {
    // 先停消费者（worker），再撤 Web 流量；API 保持维护态可诊断。
    await this.composeRun(['stop', this.config.services.worker, this.config.services.web], {
      timeoutMs: 5 * 60_000,
    });
    return { credential: `quiesce:${this.config.services.worker},${this.config.services.web}` };
  }

  // —— §5.4-4 备份 ——
  async snapshot(_ctx: StepContext): Promise<{ credential: string; backupRef: string }> {
    const backupDir = this.backupDir();
    await mkdir(backupDir, { recursive: true });
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const ref = path.join(backupDir, stamp);
    await mkdir(ref, { recursive: true });
    const dumpFile = path.join(ref, 'database.dump');
    // 在 db 容器内 pg_dump；stdoutFile 二进制安全落到 updater 卷（db 容器与该卷共享
    // 备份目录——见 Compose 部署接线）。
    await this.composeRun(
      [
        'exec',
        '-T',
        this.config.database.service,
        'pg_dump',
        '-Fc',
        '-U',
        this.config.database.user,
        this.config.database.name,
      ],
      { timeoutMs: 60 * 60_000, stdoutFile: dumpFile },
    );
    await this.snapshots.write({
      ref,
      digest: (await this.pointer.read())?.digest ?? '',
      createdAt: this.now().toISOString(),
    });
    return { credential: dumpFile, backupRef: ref };
  }

  // —— §5.4-5 一次性迁移 ——
  async migrate(ctx: StepContext): Promise<{ credential: string }> {
    // 用**新镜像**跑独立一次性迁移任务；数据库锁保证单次执行（§5.4-5）。
    await this.composeRun(
      [
        'run',
        '--rm',
        '--no-deps',
        this.config.services.api,
        'pnpm',
        '--filter',
        '@stackpanel/db',
        'migrate:deploy',
      ],
      {
        env: { [this.config.imageEnv]: this.targetImage(ctx) },
        timeoutMs: 30 * 60_000,
      },
    );
    return { credential: `migrate:${ctx.task.plan.kernel.migration}` };
  }

  // —— §5.4-6 切换到同一 release 集合 ——
  async switchTo(ctx: StepContext): Promise<{ credential: string }> {
    const image = this.targetImage(ctx);
    await this.composeRun(['up', '-d', ...this.config.allowedServices], {
      env: { [this.config.imageEnv]: image },
      timeoutMs: 15 * 60_000,
    });
    return { credential: `switched:${image}` };
  }

  // —— §5.4-7 维护态探针 ——
  async verify(ctx: StepContext): Promise<{ credential: string }> {
    const { probes } = this.config;
    const readiness = await this.probe(probes.readinessUrl, DEFAULT_PROBE_TIMEOUT_MS);
    if (!readiness) {
      throw new DeploymentAdapterError(`readiness 探针未通过：${probes.readinessUrl}`, 'verify');
    }
    if (probes.webUrl) {
      const web = await this.probe(probes.webUrl, DEFAULT_PROBE_TIMEOUT_MS);
      if (!web) {
        throw new DeploymentAdapterError(`Web 资源探针未通过：${probes.webUrl}`, 'verify');
      }
    }
    if (probes.loginProbeUrl) {
      const login = await this.probe(probes.loginProbeUrl, DEFAULT_PROBE_TIMEOUT_MS);
      if (!login) {
        throw new DeploymentAdapterError(`登录/权限探针未通过：${probes.loginProbeUrl}`, 'verify');
      }
    }
    // `up -d --wait` 只保证容器健康，不保证拉到的是目标镜像：镜像 tag 可复用、
    // 也可能被 compose 缓存在同名容器上。ADR-0025 决策 9 要求确认运行版本。
    const mismatch = await this.versionMismatch(ctx);
    if (mismatch) {
      throw new DeploymentAdapterError(`升级后探针未通过：${mismatch}`, 'verify');
    }
    return { credential: 'verify:probes-ok' };
  }

  /**
   * 比对 `/health` 汇报的版本与计划版本。返回 null 表示一致或无法判定——
   * 探针端点不返回可解析 JSON 时不判失败，避免绑死自定义部署。
   */
  private async versionMismatch(ctx: StepContext): Promise<string | null> {
    const url = this.config.probes.readinessUrl;
    const health = await this.jsonProbe(url, DEFAULT_PROBE_TIMEOUT_MS).catch(() => null);
    if (!health || typeof health.body !== 'object' || health.body === null) return null;
    const actual = (health.body as Record<string, unknown>)['version'];
    const expected = ctx.task.plan.kernel.version;
    if (typeof actual === 'string' && actual !== expected) {
      return `运行中的内核版本仍是 ${actual}，期望 ${expected}`;
    }
    return null;
  }

  // —— §5.4-8 提交 ——
  async commit(ctx: StepContext): Promise<{ credential: string }> {
    const digest = normalizeDigest(ctx.targetDigest);
    const pointer = await this.pointer.advance({ digest, now: this.now() });
    // 「up -d」退出码不作为成功依据（§5.4-8）；此处已在 verify 通过后推进指针。
    return { credential: `committed:gen=${pointer.generation}` };
  }

  // —— §5.4-9 清理观察期资源 ——
  async cleanup(_ctx: StepContext): Promise<{ credential: string }> {
    // 保留策略见 GC；此处仅回收未使用的悬空镜像标签（不删旧 digest 供回退）。
    const out = await this.runner.run({
      file: 'docker',
      args: ['image', 'prune', '-f', '--filter', 'dangling=true'],
      cwd: this.config.projectDir,
      allowNonZeroExit: true,
      timeoutMs: 5 * 60_000,
    });
    return { credential: `cleanup:${out.stdout.trim().slice(0, 64)}` };
  }

  // —— §6 失败恢复 ——
  async recover(
    _ctx: StepContext,
    failure: { stage: string; detail: string; migrated: boolean; postWrite: boolean },
  ): Promise<{ recovered: boolean; credential: string; detail?: string }> {
    const pointer = await this.pointer.read();
    // 已放行写入（postWrite）后禁止自动恢复旧快照（§6），只做兼容程序回退 / 前向修复。
    if (failure.postWrite) {
      return {
        recovered: false,
        credential: 'recover:post-write',
        detail: '已放行写入后故障：不自动回退旧快照，转入兼容回退或人工前向修复',
      };
    }
    // 迁移后且新程序不兼容旧 schema：需恢复快照与匹配旧包（§6）。
    if (failure.migrated && !failure.postWrite) {
      const snapshot = await this.snapshots.read();
      if (!snapshot) {
        return {
          recovered: false,
          credential: 'recover:no-snapshot',
          detail: '迁移后失败但无可用快照，转入人工恢复入口',
        };
      }
      await this.restoreSnapshot(snapshot.ref);
    }
    const previousDigest = pointer?.previousDigest ?? pointer?.digest;
    if (previousDigest) {
      await this.composeRun(['up', '-d', ...this.config.allowedServices], {
        env: { [this.config.imageEnv]: previousDigest },
        allowNonZeroExit: true,
        timeoutMs: 15 * 60_000,
      });
      await this.pointer.write({
        generation: pointer?.generation ?? 0,
        digest: previousDigest,
        previousDigest: pointer?.digest ?? null,
        previousGeneration: pointer?.generation ?? null,
        updatedAt: this.now().toISOString(),
      });
    }
    // 未迁移：解除维护，恢复原消费者。
    if (!failure.migrated) {
      await this.composeRun(['up', '-d', this.config.services.worker, this.config.services.web], {
        allowNonZeroExit: true,
        timeoutMs: 10 * 60_000,
      });
    }
    const readiness = await this.probe(
      this.config.probes.readinessUrl,
      DEFAULT_PROBE_TIMEOUT_MS,
    ).catch(() => false);
    return {
      recovered: readiness,
      credential: `recover:${failure.stage}`,
      detail: readiness ? '已回退并恢复服务' : '已回退但探针未通过，保持维护',
    };
  }

  // —— §5.2 独立恢复入口：回退到上一代 ——
  async rollbackToPrevious(): Promise<{ ok: boolean; detail: string }> {
    const pointer = await this.pointer.read();
    const target = pointer?.previousDigest ?? null;
    if (!pointer || !target) {
      return { ok: false, detail: '没有可回退的上一代部署（指针缺失或从未切换）' };
    }
    await this.composeRun(['up', '-d', ...this.config.allowedServices], {
      env: { [this.config.imageEnv]: target },
      timeoutMs: 15 * 60_000,
    });
    // 回退即把指针指回上一代；generation 递增以标记一次新的生效态，保留被回退的那一代
    // 供再次前滚，绝不静默丢弃现场。
    const nextGeneration = pointer.generation + 1;
    await this.pointer.write({
      generation: nextGeneration,
      digest: target,
      previousDigest: pointer.digest,
      previousGeneration: pointer.generation,
      updatedAt: this.now().toISOString(),
    });
    const readiness = await this.probe(
      this.config.probes.readinessUrl,
      DEFAULT_PROBE_TIMEOUT_MS,
    ).catch(() => false);
    return {
      ok: readiness,
      detail: readiness
        ? `已回退到上一代（generation ${nextGeneration}）`
        : `已回退但 readiness 探针未通过，保持维护（generation ${nextGeneration}）`,
    };
  }

  // —— §5.2 独立恢复入口：对账现场（幂等，不改部署） ——
  async reconcile(): Promise<{
    ok: boolean;
    generation: number;
    digest: string | null;
    detail: string;
  }> {
    const pointer = await this.pointer.read();
    const readiness = await this.probe(
      this.config.probes.readinessUrl,
      DEFAULT_PROBE_TIMEOUT_MS,
    ).catch(() => false);
    return {
      ok: readiness,
      generation: pointer?.generation ?? 0,
      digest: pointer?.digest ?? null,
      detail: readiness ? 'readiness 探针通过' : 'readiness 探针未通过',
    };
  }

  /** 用 pg_restore 从快照恢复数据库（仅 §6 允许的迁移后场景调用）。 */
  async restoreSnapshot(ref: string): Promise<void> {
    const dumpFile = path.join(ref, 'database.dump');
    await this.composeRun(
      [
        'exec',
        '-T',
        this.config.database.service,
        'pg_restore',
        '--clean',
        '--if-exists',
        '-U',
        this.config.database.user,
        '-d',
        this.config.database.name,
      ],
      { timeoutMs: 60 * 60_000, stdinFile: dumpFile },
    );
  }
}

/**
 * 归一为 `sha256:<hex>`。同时接受裸 hex、`sha256:<hex>` 与历史任务里可能残留的
 * `repo@sha256:<hex>`——后者曾被直接拼成 `sha256:repo@sha256:…`（P0-1）。
 * 无法识别时原样返回，让 docker 的明确报错暴露问题，而不是伪造一个摘要。
 */
export function normalizeDigest(digest: string): string {
  const hex = digestHex(digest);
  return hex ? `sha256:${hex}` : digest;
}

/** 解析 `df -Pk` 输出的可用字节数（第 4 列，KB）。 */
export function parseDfFreeBytes(output: string): number | null {
  const lines = output.trim().split('\n');
  const dataLine = lines[lines.length - 1];
  if (!dataLine) return null;
  const cols = dataLine.split(/\s+/);
  const availKb = Number(cols[3]);
  return Number.isFinite(availKb) ? availKb * 1024 : null;
}

const defaultProbe: Probe = async (url, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 读取探针端点的 JSON 体。非 2xx、非 JSON 或网络失败一律返回 null，
 * 由调用方按「无法判定」处理。
 */
const defaultJsonProbe: JsonProbe = async (url, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return { status: res.status, body: JSON.parse(await res.text()) as unknown };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 基于 Compose 的 updater **自升级**适配器（§5.2）。切换 updater 服务自身的镜像引用
 * （`updaterImageEnv`）并 `up -d updater`；候选启动失败由 {@link SelfUpdateExecutor}
 * 的守护者用 {@link restoreUpdater} 回退。只操作绑定的 project 与 updater 服务。
 */
export class ComposeSelfUpdateAdapter implements SelfUpdateAdapter {
  constructor(
    private readonly config: ComposeProjectConfig,
    private readonly runner: CommandRunner,
  ) {}

  private updaterService(): string {
    return this.config.updaterService ?? 'updater';
  }

  private updaterImageEnv(): string {
    return this.config.updaterImageEnv ?? 'STACKPANEL_UPDATER_IMAGE';
  }

  private composeRun(
    args: string[],
    opts: { env?: Record<string, string>; allowNonZeroExit?: boolean; timeoutMs?: number } = {},
  ): Promise<string> {
    const files = this.config.composeFiles.flatMap((f) => ['-f', f]);
    return this.runner
      .run({
        file: 'docker',
        args: ['compose', '-p', this.config.projectName, ...files, ...args],
        cwd: this.config.projectDir,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.allowNonZeroExit ? { allowNonZeroExit: true } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      })
      .then((result) => result.stdout);
  }

  /** 读取当前 updater 服务镜像引用（compose 解析后的实际值）。 */
  async currentUpdaterImage(): Promise<string> {
    const out = await this.composeRun(['images', '--format', 'json', this.updaterService()], {
      allowNonZeroExit: true,
      timeoutMs: 60_000,
    });
    // compose images --format json 每行一个对象；取含镜像引用的字段。Tag 可能是 `sha256:...`
    // （digest 引用）或普通 tag，两者都要还原成可直接比较的完整引用。
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          Repository?: string;
          Tag?: string;
          Image?: string;
        };
        if (parsed.Image) return parsed.Image;
        if (parsed.Repository && parsed.Tag) {
          const sep = parsed.Tag.startsWith('sha256:') ? '@' : ':';
          return `${parsed.Repository}${sep}${parsed.Tag}`;
        }
      } catch {
        // 非 JSON 行忽略。
      }
    }
    throw new DeploymentAdapterError('无法读取当前 updater 镜像引用', 'self-update-current');
  }

  async pullAndVerifyUpdater(digest: string): Promise<{ credential: string }> {
    const image = `${this.config.imageRepository}@${normalizeDigest(digest)}`;
    await this.runner.run({
      file: 'docker',
      args: ['pull', image],
      cwd: this.config.projectDir,
      timeoutMs: 30 * 60_000,
    });
    const inspect = await this.runner.run({
      file: 'docker',
      args: ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image],
    });
    if (!inspect.stdout.includes(normalizeDigest(digest))) {
      throw new DeploymentAdapterError(
        `候选 updater 镜像摘要不匹配：期望 ${digest}`,
        'self-update-pull',
      );
    }
    return { credential: inspect.stdout.trim() };
  }

  async switchUpdaterTo(digest: string): Promise<{ credential: string }> {
    // 只把「已含 `@`」的完整引用当完整引用；裸摘要/`sha256:` 一律与仓库拼成
    // `repo@sha256:...`，避免把 digest 当成 `repo:tag` 形态误用。
    const reference = digest.includes('@')
      ? digest
      : `${this.config.imageRepository}@${normalizeDigest(digest)}`;
    await this.composeRun(['up', '-d', this.updaterService()], {
      env: { [this.updaterImageEnv()]: reference },
      timeoutMs: 15 * 60_000,
    });
    return { credential: `self-switched:${reference}` };
  }

  async restoreUpdater(digest: string): Promise<{ credential: string }> {
    await this.composeRun(['up', '-d', this.updaterService()], {
      env: { [this.updaterImageEnv()]: digest },
      allowNonZeroExit: true,
      timeoutMs: 15 * 60_000,
    });
    return { credential: `self-restored:${digest}` };
  }
}
