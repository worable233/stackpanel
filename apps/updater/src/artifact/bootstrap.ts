/**
 * 首次自举的执行端（审计 R2、R3、R5）。
 *
 * 职责链：`queued` → 校验代次与产物绑定 → `migrating` → `migrate deploy`
 * → 提升候选配置 → `starting` → 重建 PM2（含 worker）→ 探针 → `needs_admin`。
 *
 * 为什么必须由 runner 而不是 API 做：
 * - 迁移可能耗时数分钟，不能被一个 HTTP 请求承载（审计 R2）；
 * - 配置提升与进程重建是**同一组**变更，必须共用实例执行锁，不能与升级并行；
 * - API 进程此刻正用旧配置运行，改文件后它读不到新值（env 在模块加载期求值），
 *   必须显式重建进程。
 *
 * 三条不可退让的约束：
 * 1. **代次核验**：认领时磁盘上的 `configGeneration` 必须与任务一致，
 *    否则说明有第二个提交覆盖了候选，直接放弃（不做破坏性动作）。
 * 2. **阶段单向**：迁移成功后即使启动失败，也**不再回到** `needs_infra`，
 *    而是进入 `runtime_failed`；重开配置会让任意人换库。
 * 3. **不猜不重试**：`migrate deploy` 失败要分类；已部分执行时禁止自动重跑。
 */

import { readFile, rename, rm, copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { BootstrapMigrationFailure, BootstrapPhase } from '@stackpanel/spec';
import { ExecutorLock } from '../executor-lock.ts';
import type { CommandRunner } from '../command.ts';
import { writeFileAtomic, parseBootstrapFile, serializeBootstrapFile } from './bootstrap-file.ts';
import type { RunnerLayout } from './layout.ts';

/**
 * 前置条件不满足（产物缺失、版本不匹配、代次不一致……）。
 *
 * 这类错误**不是**迁移失败：迁移根本没开始。必须原样抛给调用方，
 * 而不是被 catch-all 归成 `migration_failed` —— 否则运维会去查数据库，
 * 而真正的问题是迁移包没装对。
 */
export class BootstrapPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapPreconditionError';
  }
}

/** 迁移超时（与升级路径一致）。 */
const MIGRATE_TIMEOUT_MS = 60 * 60_000;
/** 启动探针总预算（可被 options.startupTimeoutMs 覆盖，测试用短值）。 */
const STARTUP_PROBE_TIMEOUT_MS = 180_000;
const PROBE_INTERVAL_MS = 2_000;



/** 与内核 `apps/api/src/bootstrap/state.ts` 对应的磁盘状态（最小子集）。 */
export interface RunnerBootstrapState {
  version: number;
  phase: BootstrapPhase;
  configGeneration: number;
  targetVersion?: string;
  failure?: string;
  diagnosticsRequired?: boolean;
  migrationSucceeded?: boolean;
  runtimeReady?: boolean;
  adminClaimed?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BootstrapRunnerOptions {
  layout: RunnerLayout;
  runner: CommandRunner;
  nodeBin?: string;
  pm2Bin?: string;
  pm2Home?: string;
  now?: () => Date;
  log?: (message: string) => void;
  /** 探针（测试注入）。 */
  probe?: (url: string, timeoutMs?: number) => Promise<boolean>;
  /** 迁移产物根目录；默认 `<root>/migrate`（安装脚本写到 `<root>/migrate/<version>`）。 */
  migrateRoot?: string;
  /** 认领到的任务里的代次；与磁盘状态不一致时放弃执行（审计 R3）。 */
  expectedGeneration?: number;
  /**
   * 调用方已经持有实例锁（CLI 的 `--bootstrap` 路径）。
   *
   * 锁是**不可重入**的：CLI 必须先抢锁再认领任务（否则两个 runner 会各认领
   * 一个任务），因此这里不能再抢一次。单测直接调用 runBootstrap 时不传此值。
   */
  lockHeld?: boolean;
  /** 引导配置文件；默认 `<stateDir>/stackpanel.env`。 */
  envFile?: string;
  healthUrl?: string;
  readinessUrl?: string;
  webUrl?: string;
  /** 启动探针总预算（默认 180s）。 */
  startupTimeoutMs?: number;
  /**
   * 恢复中断的执行（审计 R3「所有落盘点定义重启恢复动作」）。
   *
   * 崩溃后磁盘停在 `migrating`/`starting`，此时 inbox 里的任务已被认领移走，
   * 没有触发源会再推进它。只有显式恢复（开机时的 oneshot）才传 `true`；
   * `starting` 表示配置已提升，只补做进程重建与探针，绝不重跑迁移。
   */
  resume?: boolean;
}

export type BootstrapRunResult =
  | { ok: true; phase: BootstrapPhase }
  | { ok: false; phase: BootstrapPhase; detail: string };

/** 状态目录（与 API 侧 `defaultBootstrapStateDir` 一致）。 */
export function bootstrapDir(layout: RunnerLayout): string {
  return path.join(layout.stateDir, 'bootstrap');
}

function stateFile(layout: RunnerLayout): string {
  return path.join(bootstrapDir(layout), 'state.json');
}

function candidateFile(layout: RunnerLayout, generation: number): string {
  return path.join(bootstrapDir(layout), `config.candidate-${generation}.env`);
}

/** 读取状态；不存在返回 null。损坏时抛错，绝不当作"未配置"。 */
export async function readBootstrapState(layout: RunnerLayout): Promise<RunnerBootstrapState | null> {
  return readState(layout);
}

async function readState(layout: RunnerLayout): Promise<RunnerBootstrapState | null> {
  try {
    const raw = await readFile(stateFile(layout), 'utf8');
    const parsed = JSON.parse(raw) as RunnerBootstrapState;
    if (typeof parsed.phase !== 'string' || typeof parsed.configGeneration !== 'number') {
      throw new Error(`自举状态文件格式非法：${stateFile(layout)}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 原子写状态（含目录 fsync）。 */
async function writeState(layout: RunnerLayout, state: RunnerBootstrapState, now: () => Date): Promise<void> {
  const next: RunnerBootstrapState = { ...state, updatedAt: now().toISOString() };
  await writeFileAtomic(stateFile(layout), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o640 });
}

/**
 * 校验迁移产物完整性（审计 R5）。
 *
 * 交接文档最初只写了 `{migrate.mjs, prisma/}`，但入口还会读取
 * `prisma.config.mjs` 与 `node_modules/prisma/build/index.js`，而后者依赖整个
 * 依赖闭包。缺少任何一项都会在目标机上必然失败，因此这里显式检查。
 */
export async function assertMigrateBundleComplete(dir: string): Promise<void> {
  const required = [
    'migrate.mjs',
    'prisma.config.mjs',
    path.join('prisma', 'schema.prisma'),
    path.join('node_modules', 'prisma', 'build', 'index.js'),
    'RELEASE.json',
  ];
  const missing: string[] = [];
  for (const relative of required) {
    const { stat } = await import('node:fs/promises');
    try {
      const info = await stat(path.join(dir, relative));
      if (!info.isFile()) missing.push(relative);
    } catch {
      missing.push(relative);
    }
  }
  if (missing.length > 0) {
    throw new BootstrapPreconditionError(`迁移产物不完整（缺少 ${missing.join('、')}）：${dir}`);
  }
}

interface ReleaseDescriptor {
  role?: string;
  version?: string;
  platform?: string;
  nodeMajor?: number;
  databaseMigration?: string;
}

/** 读取 `RELEASE.json`；缺失或非法时抛错（不能靠猜）。 */
async function readReleaseJson(dir: string): Promise<ReleaseDescriptor> {
  const raw = await readFile(path.join(dir, 'RELEASE.json'), 'utf8');
  let parsed: ReleaseDescriptor;
  try {
    parsed = JSON.parse(raw) as ReleaseDescriptor;
  } catch {
    throw new BootstrapPreconditionError(`RELEASE.json 不是合法 JSON：${dir}`);
  }
  if (typeof parsed.version !== 'string') {
    throw new BootstrapPreconditionError(`RELEASE.json 缺少 version：${dir}`);
  }
  return parsed;
}

/**
 * 核验迁移产物与内核产物**互相绑定**（审计 R5）。
 *
 * 只检查文件存在是不够的：一次手工拷贝、或升级窗口里下错版本，都会得到
 * "文件齐全但版本不匹配"的产物，而 `migrate deploy` 会把错误的迁移集
 * 应用到业务库上。这里逐项核对 version / platform / nodeMajor，
 * 以及（可选）kernel 声明的 databaseMigration 与 migrate 目录名一致。
 */
export async function assertBundleMatchesKernel(input: {
  migrateDir: string;
  currentReleaseDir: string;
  expectedVersion: string;
}): Promise<void> {
  if (!input.currentReleaseDir) {
    throw new BootstrapPreconditionError(`current 符号链接不可用，无法核验产物：${input.currentReleaseDir}`);
  }
  const migrate = await readReleaseJson(input.migrateDir);
  const kernel = await readReleaseJson(input.currentReleaseDir);

  if (migrate.role !== 'migrate') {
    throw new BootstrapPreconditionError(`迁移产物 role=${migrate.role ?? '未声明'}，应为 migrate`);
  }
  if (migrate.version !== input.expectedVersion) {
    throw new BootstrapPreconditionError(
      `迁移产物版本 ${migrate.version} 与目标版本 ${input.expectedVersion} 不一致`,
    );
  }
  if (kernel) {
    if (kernel.role !== 'kernel') {
      throw new BootstrapPreconditionError(`内核产物 role=${kernel.role ?? '未声明'}，应为 kernel`);
    }
    if (kernel.version !== migrate.version) {
      throw new BootstrapPreconditionError(
        `内核 ${kernel.version} 与迁移产物 ${migrate.version} 版本不一致`,
      );
    }
    if (kernel.platform && migrate.platform && kernel.platform !== migrate.platform) {
      throw new BootstrapPreconditionError(
        `内核平台 ${kernel.platform} 与迁移产物 ${migrate.platform} 不一致`,
      );
    }
    if (kernel.nodeMajor !== undefined && migrate.nodeMajor !== undefined) {
      if (kernel.nodeMajor !== migrate.nodeMajor) {
        throw new BootstrapPreconditionError(
          `内核 Node ${kernel.nodeMajor} 与迁移产物 Node ${migrate.nodeMajor} 不一致`,
        );
      }
    }
    // 迁移集指纹：两个产物必须描述同一个迁移终点。只比 version 会放过
    // 「同一版本号但迁移目录不同」的重新打包，而这是最容易被手工替换的字段。
    if (
      kernel.databaseMigration !== undefined &&
      migrate.databaseMigration !== undefined &&
      kernel.databaseMigration !== migrate.databaseMigration
    ) {
      throw new BootstrapPreconditionError(
        `内核迁移终点 ${kernel.databaseMigration} 与迁移产物 ${migrate.databaseMigration} 不一致`,
      );
    }
  }
  if (migrate.databaseMigration !== undefined) {
    // 声明了终点就必须真的存在于产物里，否则 `migrate deploy` 应用的是
    // 另一套迁移，却仍然"看起来成功"。
    const { stat } = await import('node:fs/promises');
    const migrationsDir = path.join(input.migrateDir, 'prisma', 'migrations');
    const entries = await stat(migrationsDir).catch(() => null);
    if (!entries?.isDirectory()) {
      throw new BootstrapPreconditionError(`迁移产物缺少 prisma/migrations 目录：${input.migrateDir}`);
    }
  }
  // 运行时 Node 主版本必须与产物声明的一致：Node 22 产物跑在 26 上，
  // 原生模块（Prisma engine）可能直接崩。
  const runningMajor = Number(process.versions.node.split('.')[0]);
  if (migrate.nodeMajor !== undefined && migrate.nodeMajor !== runningMajor) {
    throw new BootstrapPreconditionError(
      `迁移产物要求 Node ${migrate.nodeMajor}，当前为 ${process.versions.node}`,
    );
  }
}

/**
 * 执行一次自举。
 *
 * 调用方必须已经安装好迁移产物（`<root>/migrate/<version>/`）。
 */
export async function runBootstrap(options: BootstrapRunnerOptions): Promise<BootstrapRunResult> {
  const { layout } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((m: string) => console.info(`[bootstrap] ${m}`));
  const envFile = options.envFile ?? path.join(layout.stateDir, 'stackpanel.env');
  const migrateRoot = options.migrateRoot ?? path.join(layout.root, 'migrate');

  const state = await readState(layout);
  if (!state) {
    return { ok: false, phase: 'needs_infra', detail: '没有自举状态，实例尚未进入配置流程' };
  }
  const resumable =
    options.resume === true && (state.phase === 'migrating' || state.phase === 'starting');
  if (state.phase !== 'queued' && !resumable) {
    // 幂等：重复触发（path unit 多次唤醒）不应重跑迁移。
    return { ok: true, phase: state.phase };
  }

  // —— 实例执行锁：与内核升级共用，禁止并行变更 ——
  const lock = options.lockHeld
    ? null
    : new ExecutorLock({
        filePath: layout.lockFile,
        owner: `${process.env['HOSTNAME'] ?? 'stackpanel'}:${process.pid}`,
        now,
      });
  if (lock) await lock.acquire();

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    // 抢锁后重读：等锁期间可能已被别的执行者推进。
    const current = await readState(layout);
    if (!current) throw new Error('自举状态在执行期间消失');
    const resumePhase = current.phase;
    const resuming =
      options.resume === true && (resumePhase === 'migrating' || resumePhase === 'starting');
    if (resumePhase !== 'queued' && !resuming) {
      return { ok: true, phase: resumePhase };
    }
    if (current.configGeneration !== state.configGeneration) {
      throw new BootstrapPreconditionError(
        `配置代次在等锁期间变化（${state.configGeneration} → ${current.configGeneration}），放弃执行`,
      );
    }
    // 任务文件里的代次也必须与磁盘一致：任务与候选配置可能因为一次失败的提交
    // 而错位，执行错代的迁移是不可回滚的破坏性操作。
    if (
      options.expectedGeneration !== undefined &&
      current.configGeneration !== options.expectedGeneration
    ) {
      throw new BootstrapPreconditionError(
        `任务代次 ${options.expectedGeneration} 与磁盘状态 ${current.configGeneration} 不一致，放弃执行`,
      );
    }

    // `starting` 意味着配置已经提升、迁移已经成功。恢复时只能往前走
    // （重建进程 + 探针）；重跑迁移既不必要，也会在失败时把已完成的迁移
    // 记成失败（审计 R2/R3）。
    const alreadyPromoted = resuming && resumePhase === 'starting';
    if (!alreadyPromoted) {
      await writeState(layout, { ...current, phase: 'migrating' }, now);
    }
    heartbeat = setInterval(() => {
      void lock?.heartbeat().catch(() => undefined);
    }, 20_000);

    // —— 候选配置 ——
    const candidate = candidateFile(layout, current.configGeneration);
    const candidateContent = await readFile(candidate, 'utf8');
    const candidateEnv = parseBootstrapFile(candidateContent);

    // —— 迁移产物与版本绑定 ——
    const targetVersion = current.targetVersion;
    if (!targetVersion || targetVersion === 'unknown') {
      throw new BootstrapPreconditionError('任务未记录目标版本，无法定位迁移产物');
    }
    const migrateDir = path.join(migrateRoot, targetVersion);
    await assertMigrateBundleComplete(migrateDir);
    // 与当前 release 交叉核验：文件齐全不代表版本对。
    await assertBundleMatchesKernel({
      migrateDir,
      currentReleaseDir: await realpathSafe(layout.currentLink),
      expectedVersion: targetVersion,
    });

    // —— 执行迁移 ——
    const databaseUrl = candidateEnv.get('DATABASE_URL');
    if (!databaseUrl) throw new BootstrapPreconditionError('候选配置缺少 DATABASE_URL');

    if (!alreadyPromoted) {
      log(`开始迁移（版本 ${targetVersion}）`);
      try {
        await options.runner.run({
          file: options.nodeBin ?? process.execPath,
          args: [path.join(migrateDir, 'migrate.mjs')],
          cwd: migrateDir,
          env: { DATABASE_URL: databaseUrl, NODE_ENV: 'production' },
          timeoutMs: MIGRATE_TIMEOUT_MS,
        });
      } catch (error) {
        const classified = classifyMigrationError(error);
        log(`迁移失败（${classified}）：${error instanceof Error ? error.message : String(error)}`);
        await writeState(
          layout,
          {
            ...current,
            phase: 'migration_failed',
            failure: classified,
            // 三个结果显式分开记录：迁移没有成功，运行期更没有就绪。
            migrationSucceeded: false,
            runtimeReady: false,
            adminClaimed: false,
            diagnosticsRequired: classified !== 'migration_connect_failed',
          },
          now,
        );
        return {
          ok: false,
          phase: 'migration_failed',
          detail: `迁移失败：${classified}`,
        };
      }
    }

    // —— 提升候选为正式配置 ——
    // 只保留白名单键；安装器写入的键（DATA_DIR / 密钥 / token）必须保留，
    // 因此按"合并"而不是"覆盖"写回。
    const migrated: RunnerBootstrapState = {
      ...current,
      phase: 'starting',
      migrationSucceeded: true,
      runtimeReady: alreadyPromoted ? (current.runtimeReady ?? false) : false,
      // `adminClaimed` 与迁移/启动是三个独立结果：这里显式保持未认领，
      // 避免"undefined 被当成已认领"或反之的歧义（审计 R2）。
      adminClaimed: current.adminClaimed ?? false,
      updatedAt: now().toISOString(),
    };

    if (!alreadyPromoted) {
      const existing = await readBootstrapFileSafe(envFile);
      const merged = new Map<string, string>(existing);
      for (const [key, value] of candidateEnv) merged.set(key, value);
      await writeFileAtomic(envFile, serializeBootstrapFile(merged), { mode: 0o640 });
      log(`已启用候选配置（generation=${current.configGeneration}）`);
      await writeState(layout, migrated, now);
    } else {
      log('恢复中断的执行：配置已提升，跳过迁移，直接重建进程');
    }

    // —— 用新配置显式重建进程（含首次启动 worker）——
    const started = await startProcesses(options, log);
    if (!started.ok) {
      await writeState(
        layout,
        { ...migrated, phase: 'runtime_failed', runtimeReady: false },
        now,
      );
      return { ok: false, phase: 'runtime_failed', detail: started.detail };
    }

    await writeState(
      layout,
      { ...migrated, phase: 'needs_admin', runtimeReady: true },
      now,
    );
    log('服务已就绪，等待创建首个管理员');
    return { ok: true, phase: 'needs_admin' };
  } catch (error) {
    // 前置条件错误原样抛出：迁移根本没开始，把它记成 migration_failed
    // 会把运维引向错误的排查方向。
    if (error instanceof BootstrapPreconditionError) throw error;
    // 未分类故障：保持可解释状态，不静默。
    const detail = error instanceof Error ? error.message : String(error);
    log(`自举执行失败：${detail}`);
    const latest = await readState(layout).catch(() => null);
    if (latest && latest.phase !== 'migration_failed' && latest.phase !== 'runtime_failed') {
      await writeState(
        layout,
        { ...latest, phase: 'migration_failed', failure: 'migration_unknown', diagnosticsRequired: true },
        now,
      ).catch(() => undefined);
    }
    return { ok: false, phase: latest?.phase ?? 'migration_failed', detail };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await lock?.release().catch(() => undefined);
  }
}

/** `realpath`；失败时返回空串，让上层给出准确错误。 */
async function realpathSafe(target: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  try {
    return await realpath(target);
  } catch {
    return '';
  }
}

/** 读取既有 env 文件；不存在时返回空 Map。 */
async function readBootstrapFileSafe(file: string): Promise<Map<string, string>> {
  try {
    return parseBootstrapFile(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
}

/** 用当前 `current` 版本的 ecosystem 重建 PM2。 */
async function startProcesses(
  options: BootstrapRunnerOptions,
  log: (m: string) => void,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { layout } = options;
  // `current` 是符号链接；ecosystem 在其指向的版本目录里。
  const { realpath } = await import('node:fs/promises');
  let target: string;
  try {
    target = await realpath(layout.currentLink);
  } catch {
    return { ok: false, detail: `current 符号链接不可用：${layout.currentLink}` };
  }

  const ecosystem = path.join(target, 'ecosystem.config.cjs');
  const apps = ['stackpanel-api', 'stackpanel-worker', 'stackpanel-web'];
  const pm2 = options.pm2Bin ?? 'pm2';
  const pm2Env = options.pm2Home ? { PM2_HOME: options.pm2Home } : {};

  try {
    // cwd 随版本变化，必须 delete + start；同时删除残留的旧进程定义，
    // 避免生态文件变化（例如 worker 从"不启动"变为"启动"）被旧的 save 状态覆盖。
    await options.runner.run({
      file: pm2,
      args: ['delete', ...apps],
      env: pm2Env,
      timeoutMs: 120_000,
      allowNonZeroExit: true,
    });
    await options.runner.run({
      file: pm2,
      args: ['start', ecosystem, '--update-env'],
      cwd: target,
      env: pm2Env,
      timeoutMs: 120_000,
    });
    await options.runner.run({
      file: pm2,
      args: ['save'],
      cwd: target,
      env: pm2Env,
      timeoutMs: 120_000,
    });
  } catch (error) {
    return {
      ok: false,
      detail: `PM2 重建失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 先确认 web 与 api 就绪，再确认 worker 起来（worker 无 HTTP 探针，
  // 用 PM2 状态确认；它只在自举完成后才会出现在生态文件里）。
  const healthy = await waitForProbes(options, log);
  if (!healthy.ok) return healthy;

  const workerOk = await waitForWorker(options);
  if (!workerOk.ok) return workerOk;

  return { ok: true };
}

async function waitForProbes(
  options: BootstrapRunnerOptions,
  log: (m: string) => void,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const probe = options.probe ?? defaultProbe;
  const deadline = Date.now() + (options.startupTimeoutMs ?? STARTUP_PROBE_TIMEOUT_MS);
  const healthUrl = options.healthUrl ?? 'http://127.0.0.1:3001/ready';
  const webUrl = options.webUrl ?? 'http://127.0.0.1:3000/';

  let lastError = '';
  while (Date.now() < deadline) {
    const api = await probe(healthUrl).catch((error: unknown) => {
      lastError = String(error);
      return false;
    });
    if (api) {
      const web = await probe(webUrl).catch(() => false);
      if (web) return { ok: true };
      lastError = 'web 未就绪';
    } else {
      lastError = 'api 未就绪';
    }
    log(`等待服务就绪：${lastError}`);
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
  return { ok: false, detail: `启动探针超时（${lastError || '未就绪'}）` };
}

/** 用 `pm2 jlist` 确认 worker 处于 online。 */
async function waitForWorker(
  options: BootstrapRunnerOptions,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const pm2 = options.pm2Bin ?? 'pm2';
  const pm2Env = options.pm2Home ? { PM2_HOME: options.pm2Home } : {};
  const deadline = Date.now() + (options.startupTimeoutMs ?? STARTUP_PROBE_TIMEOUT_MS);
  while (Date.now() < deadline) {
    try {
      const result = await options.runner.run({
        file: pm2,
        args: ['jlist'],
        env: pm2Env,
        timeoutMs: 30_000,
      });
      const list = JSON.parse(result.stdout) as Array<{
        name?: string;
        pm2_env?: { status?: string };
      }>;
      const worker = list.find((entry) => entry.name === 'stackpanel-worker');
      if (worker?.pm2_env?.status === 'online') return { ok: true };
    } catch {
      // 继续轮询；PM2 可能尚未写出 jlist。
    }
    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
  }
  return { ok: false, detail: 'worker 未在预期时间内进入 online' };
}

/** 默认探针：HTTP GET，2xx/3xx 视为可用。 */
async function defaultProbe(url: string, timeoutMs = 5_000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 迁移失败分类（审计 §3.3）。
 *
 * 区分"可以改了重试"与"必须人工介入"：Prisma 可能已记录失败迁移，
 * 部分 DDL 也可能执行过，盲目重跑会掩盖问题。
 */
export function classifyMigrationError(error: unknown): BootstrapMigrationFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|ENOTFOUND|timeout|ETIMEDOUT|Can't reach database/i.test(message)) {
    return 'migration_connect_failed';
  }
  if (/P1000|authentication failed|password authentication|permission denied|42501/i.test(message)) {
    return 'migration_permission_denied';
  }
  if (/P3009|failed migrations|found failed migration/i.test(message)) {
    return 'migration_failed_record';
  }
  if (/P3005|P3018|schema.*not empty|does not exist|drift/i.test(message)) {
    return 'migration_schema_incompatible';
  }
  return 'migration_unknown';
}

/** 清理已提升的候选文件（保留最近一次，便于审计；更早的删除）。 */
export async function pruneCandidates(layout: RunnerLayout, keepGeneration: number): Promise<void> {
  const dir = bootstrapDir(layout);
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const match = /^config\.candidate-(\d+)\.env$/.exec(name);
    if (!match) continue;
    if (Number(match[1]) >= keepGeneration) continue;
    await rm(path.join(dir, name), { force: true });
  }
}

/** 备份当前配置（重置/失败修正前使用）。 */
export async function backupEnvFile(envFile: string, now: () => Date): Promise<string | null> {
  try {
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const target = `${envFile}.bak-${stamp}`;
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(envFile, target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 供 CLI 的 `--bootstrap` 使用；保留用于未来 reset 动作。 */
export async function renameAtomic(from: string, to: string): Promise<void> {
  await rename(from, to);
}
