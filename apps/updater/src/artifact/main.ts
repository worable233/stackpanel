/**
 * 产物载体的 systemd oneshot 入口（ADR-0025 决策 4）。
 *
 * 无常驻进程：`stackpanel-upgrade.path` 监听
 * `/var/lib/stackpanel/update/inbox/<instance>/*.json`，触发 `Type=oneshot` 服务。
 *
 * ```
 * stackpanel-upgrade --drain               # 循环处理通道直到为空才退出（systemd 默认）
 * stackpanel-upgrade --request <file>      # CLI 逃生门：直接执行一个任务文件
 * stackpanel-upgrade --rollback            # 回退到上一版 release
 * stackpanel-upgrade --reconcile           # 只读对账（不改变部署）
 * ```
 *
 * `--drain` 覆盖「执行期间新请求到达」的窗口：runner 不退出，继续认领，直到 inbox 为空。
 * 开机时 path unit 重新武装，中断的升级由权威日志续跑（§5.3）。
 */

import { readFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  UPDATE_PROTOCOL_VERSION,
  isSha256Hex,
  updateChannelDir,
  updateTaskFileName,
  type UpdatePhase,
  type UpdateTask,
  type UpdateTaskResult,
} from '@stackpanel/spec';
import { isEntrypoint } from '../entrypoint.ts';
import { UpdateEngine } from '../engine.ts';
import { FileUpdateJournal } from '../journal.ts';
import { ExecutorLock } from '../executor-lock.ts';
import { FileUpdateTaskChannel } from '../task-channel.ts';
import { FileDeploymentPointer } from '../deployment-pointer.ts';
import { FileUpdaterStatus } from '../status.ts';
import { SpawnCommandRunner, type CommandRunner } from '../command.ts';
import { ArtifactDeploymentAdapter } from './adapter.ts';
import { layoutFromEnv, type RunnerLayout } from './layout.ts';

export interface RunnerOptions {
  layout: RunnerLayout;
  /** 命令行模式。 */
  mode: 'drain' | 'request' | 'rollback' | 'reconcile' | 'requeue';
  /** `--request` 的任务文件。 */
  requestFile?: string;
  /** 命令执行器（测试注入）。 */
  runner?: CommandRunner;
  /** 探针（测试注入）。 */
  probe?: (url: string, timeoutMs?: number) => Promise<boolean>;
  /** PM2 可执行名与 PM2_HOME。 */
  pm2Bin?: string;
  pm2Home?: string;
  /** 维护态探针地址；缺省由 `STACKPANEL_*_URL` 环境变量或适配器默认值给出。 */
  probes?: { healthUrl?: string; readinessUrl?: string; webUrl?: string };
  now?: () => Date;
  log?: (message: string) => void;
}

const APP_ROLES = { api: 'stackpanel-api', worker: 'stackpanel-worker', web: 'stackpanel-web' };

/**
 * 组装并执行。返回进程退出码：0 表示全部处理完且无失败任务。
 */
export async function runUpgrade(options: RunnerOptions): Promise<number> {
  const { layout } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message: string) => console.info(`[upgrade] ${message}`));

  await prepareLayout(layout);

  const adapter = new ArtifactDeploymentAdapter({
    layout,
    // 迁移用当前 Node 的绝对路径（systemd 的 PATH 可能不含 node），因此把
    // `process.execPath` 与 `node` 一起加入白名单；其余命令仍是固定集合。
    runner:
      options.runner ?? new SpawnCommandRunner([...RUNNER_ALLOWED_FILES, 'node', process.execPath]),
    pm2Bin: options.pm2Bin ?? 'pm2',
    pm2Apps: APP_ROLES,
    ...(options.pm2Home ? { pm2Home: options.pm2Home } : {}),
    ...(options.probe ? { probe: options.probe } : {}),
    ...(options.probes ? { probes: options.probes } : {}),
    ...(process.env['STACKPANEL_DATABASE_BACKUP'] === 'off' ? { databaseBackup: false } : {}),
    now,
    log,
  });

  if (options.mode === 'rollback') {
    const result = await adapter.rollbackToPrevious();
    log(result.detail);
    return result.ok ? 0 : 1;
  }
  if (options.mode === 'reconcile') {
    const result = await adapter.reconcile();
    log(result.detail);
    return result.ok ? 0 : 1;
  }

  if (options.mode === 'requeue') {
    // 崩溃后把 claimed/ 里的任务移回 inbox/。只有拿到执行权才动，避免与在跑的
    // runner 抢同一任务（§5.2：同一实例禁止并行变更）。
    const guard = new ExecutorLock({
      filePath: layout.lockFile,
      owner: `${process.env['HOSTNAME'] ?? 'stackpanel'}:${process.pid}`,
      now,
    });
    await guard.acquire();
    try {
      const moved = await requeueClaimed(layout);
      log(`已重新入队 ${moved} 个任务`);
    } finally {
      await guard.release();
    }
    return 0;
  }

  const channel = new FileUpdateTaskChannel(layout.channelRoot);
  const journal = new FileUpdateJournal(layout.journalFile);
  const lock = new ExecutorLock({
    filePath: layout.lockFile,
    owner: `${process.env['HOSTNAME'] ?? 'stackpanel'}:${process.pid}`,
    now,
  });
  const engine = new UpdateEngine({ adapter, journal, lock, workDir: layout.workDir, now });
  const pointer = FileDeploymentPointer.resolve(layout.updateDir);
  const status = FileUpdaterStatus.resolve(layout.updateDir);

  if (options.mode === 'request') {
    if (!options.requestFile) throw new Error('--request 需要任务文件路径');
    const task = await readTaskFile(options.requestFile, layout.instanceId);
    return executeOne(task, {
      engine,
      journal,
      heartbeat: () => lock.heartbeat(),
      channel,
      pointer,
      status,
      instanceId: layout.instanceId,
      now,
      log,
    });
  }

  // --drain：直到 inbox 为空才退出；单个任务失败不阻断后续任务。
  let failures = 0;
  for (;;) {
    const task = await channel.claim(layout.instanceId);
    if (!task) break;
    const code = await executeOne(task, {
      engine,
      journal,
      heartbeat: () => lock.heartbeat(),
      channel,
      pointer,
      status,
      instanceId: layout.instanceId,
      now,
      log,
    });
    if (code !== 0) failures += 1;
  }
  return failures === 0 ? 0 : 1;
}

interface ExecuteDeps {
  engine: UpdateEngine;
  journal: FileUpdateJournal;
  heartbeat: () => Promise<void>;
  channel: FileUpdateTaskChannel;
  pointer: FileDeploymentPointer;
  status: FileUpdaterStatus;
  instanceId: string;
  now: () => Date;
  log: (message: string) => void;
}

async function executeOne(task: UpdateTask, deps: ExecuteDeps): Promise<number> {
  validateTask(task, deps.instanceId);
  deps.log(`开始处理任务 ${task.idempotencyKey}（${task.plan.kernel.version}）`);
  await deps.channel.archiveTask(task);
  await publish(deps, task.idempotencyKey);
  let result: Awaited<ReturnType<UpdateEngine['run']>>;
  // 下载/迁移可能远超锁的失联阈值：执行期间定期续心跳，避免第二个 runner 误接管。
  const heartbeat = setInterval(() => {
    void deps.heartbeat().catch(() => undefined);
  }, 20_000);
  try {
    result = await deps.engine.run(task, true);
  } catch (error) {
    // 执行权被接管或状态机拒绝：任务留在 claimed/ 供人工/下次对账，不伪造结果。
    deps.log(
      `任务 ${task.idempotencyKey} 未执行：${error instanceof Error ? error.message : error}`,
    );
    return 1;
  } finally {
    clearInterval(heartbeat);
  }
  const projection = await projectResult(task, result, deps.journal);
  await deps.channel.complete(task, projection);
  await publish(deps, null, { idempotencyKey: task.idempotencyKey, result: projection });
  deps.log(`任务 ${task.idempotencyKey} 结束：${projection.phase}`);
  return projection.phase === 'committed' ? 0 : 1;
}

async function publish(
  deps: ExecuteDeps,
  activeTask: string | null,
  completed?: { idempotencyKey: string; result: UpdateTaskResult },
): Promise<void> {
  const pointer = await deps.pointer.read();
  const previous = (await deps.status.read())?.recent ?? [];
  const recent = completed
    ? [completed, ...previous.filter((entry) => entry.idempotencyKey !== completed.idempotencyKey)]
    : previous;
  await deps.status.write({
    generation: pointer?.generation ?? 0,
    digest: pointer?.digest ?? null,
    activeTask,
    recent: recent.slice(0, 20),
    updatedAt: deps.now().toISOString(),
  });
}

async function projectResult(
  task: UpdateTask,
  result: { phase: string; detail?: string; checkpoints: number },
  journal: FileUpdateJournal,
): Promise<UpdateTaskResult> {
  const entries = await journal.forTask(`${task.instanceId}:${task.idempotencyKey}`);
  const checkpoints = entries
    .filter((entry) => entry.phase !== 'recovering' && entry.phase !== 'queued')
    .map((entry) => ({
      phase: entry.phase,
      at: entry.at,
      inputDigest: entry.inputDigest,
      ...(entry.credential !== undefined ? { credential: entry.credential } : {}),
    }));
  const phase = result.phase as UpdatePhase;
  return {
    phase,
    checkpoints,
    ...(phase === 'recovered' || phase === 'recovery_failed'
      ? {
          recovery: {
            recovered: phase === 'recovered',
            detail: result.detail ?? phase,
          },
        }
      : {}),
  };
}

/** 任务校验：载体、协议、实例与摘要一致性。导出以便单测覆盖这几条安全边界。 */
export function validateTask(task: UpdateTask, instanceId: string): void {
  if (task.protocolVersion !== UPDATE_PROTOCOL_VERSION) {
    throw new Error(`不支持的升级协议版本：${task.protocolVersion}`);
  }
  if (task.instanceId !== instanceId) {
    throw new Error(`任务属于实例 ${task.instanceId}，本 runner 绑定 ${instanceId}`);
  }
  const kernel = task.plan.kernel;
  if (kernel.carrier !== 'artifact') {
    throw new Error(`runner 只执行 artifact 载体任务，实际为 ${kernel.carrier ?? 'oci'}`);
  }
  // 计划与任务摘要都必须是裸 hex：API 已在求解/落任务时归一，出现引用形态说明投递端
  // 仍是旧版本。拒绝执行比默默接受更能暴露契约漂移。
  const hex = kernel.digest;
  if (!isSha256Hex(hex)) {
    throw new Error(`计划的内核摘要必须是裸 64 位 hex：${kernel.digest}`);
  }
  if (!isSha256Hex(task.targetDigest)) {
    throw new Error(`task.targetDigest 必须是裸 64 位 hex：${task.targetDigest}`);
  }
  if (task.targetDigest !== hex) {
    throw new Error(`task.targetDigest 与计划摘要不一致：${task.targetDigest} vs ${kernel.digest}`);
  }
}

async function readTaskFile(file: string, instanceId: string): Promise<UpdateTask> {
  const raw = await readFile(path.resolve(file), 'utf8');
  const parsed = JSON.parse(raw) as UpdateTask;
  validateTask(parsed, instanceId);
  return parsed;
}

/** 目录与权限准备；已存在则保持。`current` 缺失不算错误（首装由安装脚本创建）。 */
async function prepareLayout(layout: RunnerLayout): Promise<void> {
  for (const dir of [
    layout.releasesDir,
    layout.stagingDir,
    layout.binDir,
    layout.dataDir,
    layout.logsDir,
    layout.backupsDir,
    layout.updateDir,
    layout.workDir,
    layout.downloadsDir,
    updateChannelDir(layout.channelRoot, 'inbox', layout.instanceId),
    updateChannelDir(layout.channelRoot, 'claimed', layout.instanceId),
    updateChannelDir(layout.channelRoot, 'results', layout.instanceId),
  ]) {
    await mkdir(dir, { recursive: true });
  }
}

/** 允许 runner 调用的宿主命令（固定集合，不经 shell）。 */
export const RUNNER_ALLOWED_FILES: readonly string[] = Object.freeze([
  'pm2',
  'tar',
  'zstd',
  'pg_dump',
  'pg_restore',
  'df',
]);

/**
 * 把 `claimed/` 中遗留的任务移回 `inbox/`（崩溃后重新武装用）。
 * 仅在显式调用时执行，避免与正在执行的任务抢锁。
 */
export async function requeueClaimed(layout: RunnerLayout): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  const claimed = updateChannelDir(layout.channelRoot, 'claimed', layout.instanceId);
  const inbox = updateChannelDir(layout.channelRoot, 'inbox', layout.instanceId);
  const names = await readdir(claimed).catch(() => [] as string[]);
  let moved = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    await rename(path.join(claimed, name), path.join(inbox, updateTaskFileName(name.slice(0, -5))));
    moved += 1;
  }
  return moved;
}

/** 解析 CLI 参数（无第三方依赖）。 */
export function parseRunnerArgs(
  argv: string[],
):
  | { mode: 'drain' | 'rollback' | 'reconcile' | 'requeue' }
  | { mode: 'request'; requestFile: string }
  | { mode: 'help' } {
  let mode: 'drain' | 'request' | 'rollback' | 'reconcile' | 'requeue' = 'drain';
  let requestFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === '--help' || token === '-h') return { mode: 'help' };
    if (token === '--drain') mode = 'drain';
    else if (token === '--rollback') mode = 'rollback';
    else if (token === '--reconcile') mode = 'reconcile';
    else if (token === '--requeue') mode = 'requeue';
    else if (token === '--request') {
      const next = argv[index + 1];
      if (!next) throw new Error('--request 需要任务文件路径');
      mode = 'request';
      requestFile = next;
      index += 1;
    } else if (token.startsWith('--request=')) {
      mode = 'request';
      requestFile = token.slice('--request='.length);
    } else {
      throw new Error(`未知参数：${token}`);
    }
  }
  return mode === 'request' ? { mode, requestFile: requestFile as string } : { mode };
}

const USAGE = `stackpanel-upgrade — 产物载体内核升级执行者（ADR-0025）

用法：
  stackpanel-upgrade --drain                处理更新通道直到为空（systemd oneshot 默认）
  stackpanel-upgrade --request <file>       直接执行一个任务文件（逃生门）
  stackpanel-upgrade --rollback             回退到上一版 release
  stackpanel-upgrade --reconcile            只读对账（不改变部署）
  stackpanel-upgrade --requeue              把崩溃后遗留的 claimed 任务移回 inbox

环境变量：
  STACKPANEL_ROOT                 安装根，默认 /opt/stackpanel
  STACKPANEL_STATE_DIR            状态根，默认 /var/lib/stackpanel
  STACKPANEL_UPDATE_INSTANCE_ID   实例 ID，默认 stackpanel
  STACKPANEL_RELEASE_RETENTION    保留 release 数，默认 2
  STACKPANEL_PM2_HOME             PM2 状态目录（必须与业务进程一致）
  STACKPANEL_HEALTH_URL           API 存活探针，默认 http://127.0.0.1:3001/health
  STACKPANEL_READINESS_URL        API 就绪探针，默认 http://127.0.0.1:3001/ready
  STACKPANEL_WEB_URL              Web 探针，默认 http://127.0.0.1:3000/
  DATABASE_URL                    迁移与快照使用的数据库连接串
  STACKPANEL_DATABASE_BACKUP=off  跳过数据库快照（仅当备份由外部系统负责）
`;

async function cli(): Promise<void> {
  const parsed = parseRunnerArgs(process.argv.slice(2));
  if (parsed.mode === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  const layout = layoutFromEnv();
  const probes = {
    ...(process.env['STACKPANEL_HEALTH_URL']
      ? { healthUrl: process.env['STACKPANEL_HEALTH_URL'] }
      : {}),
    ...(process.env['STACKPANEL_READINESS_URL']
      ? { readinessUrl: process.env['STACKPANEL_READINESS_URL'] }
      : {}),
    ...(process.env['STACKPANEL_WEB_URL'] ? { webUrl: process.env['STACKPANEL_WEB_URL'] } : {}),
  };
  const code = await runUpgrade({
    layout,
    ...parsed,
    ...(process.env['STACKPANEL_PM2_HOME'] ? { pm2Home: process.env['STACKPANEL_PM2_HOME'] } : {}),
    ...(Object.keys(probes).length > 0 ? { probes } : {}),
  });
  process.exitCode = code;
}

if (process.argv[1] && isEntrypoint(process.argv[1])) {
  cli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
