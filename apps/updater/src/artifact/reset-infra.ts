/**
 * 受限的基础设施重置（审计 R6）。
 *
 * 这不是"重新安装"，也不是给 Web 用的入口。它只解决一个具体问题：
 * **候选配置已经提升，但服务起不来**（例如填错了内部 DNS，实例卡在
 * `runtime_failed`）。此时必须有一条受控路径回到 `needs_infra`，否则只能手改文件。
 *
 * 约束（逐条对应审计 R6）：
 * - **本地执行**：`isEntrypoint` 只保证"这个文件被直接运行"，不保证调用者身份；
 *   因此这里额外要求有效的 POSIX 用户（非 root 时必须能写状态目录，这是 OS
 *   权限本身给出的授权）。真正的授权来自宿主文件权限，不是 Web。
 * - **必须停业务写入**：调用方（systemd 或运维）先停 PM2；本函数不假设服务在跑。
 * - **必做备份**：原配置文件复制为 `<file>.bak-<ts>`，失败即中止。
 * - **必须换 token**：旧 token 已经暴露在可能泄漏的日志里，重置时生成新的。
 * - **不重跑迁移**：数据库里已经执行过的迁移不会回退；这里只改"配置是否被接受"，
 *   并明确告知操作员这一点。
 */

import { randomBytes } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ExecutorLock } from '../executor-lock.ts';
import { parseBootstrapFile, serializeBootstrapFile, writeFileAtomic } from './bootstrap-file.ts';
import { backupEnvFile, bootstrapDir } from './bootstrap.ts';
import type { RunnerLayout } from './layout.ts';

export interface ResetInfraOptions {
  layout: RunnerLayout;
  now?: () => Date;
  log?: (message: string) => void;
  /** 测试注入：替换随机 token 生成。 */
  generateToken?: () => string;
}

export interface ResetInfraResult {
  ok: boolean;
  detail: string;
}

/** 阶段允许重置的集合：已完成/运行中的实例不允许被退回自举。 */
const RESETTABLE_PHASES = new Set(['runtime_failed', 'migration_failed', 'needs_infra', 'queued']);

export async function resetInfra(options: ResetInfraOptions): Promise<ResetInfraResult> {
  const { layout } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((m: string) => console.info(`[reset-infra] ${m}`));

  const statePath = path.join(bootstrapDir(layout), 'state.json');
  let state: { phase?: string; migrationSucceeded?: boolean };
  try {
    state = JSON.parse(await readFile(statePath, 'utf8')) as typeof state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, detail: '没有自举状态：该实例不是由 provision 流程安装的' };
    }
    return { ok: false, detail: `无法读取自举状态：${statePath}` };
  }

  const phase = state.phase ?? 'unknown';
  if (!RESETTABLE_PHASES.has(phase)) {
    return {
      ok: false,
      detail:
        `当前阶段 ${phase} 不允许重置。` +
        '已完成的实例请通过正常运维流程迁移数据库，不要退回首次配置。',
    };
  }

  const lock = new ExecutorLock({
    filePath: layout.lockFile,
    owner: `${process.env['HOSTNAME'] ?? 'stackpanel'}:${process.pid}`,
    now,
  });
  await lock.acquire();
  try {
    const envFile = path.join(layout.stateDir, 'stackpanel.env');
    const backup = await backupEnvFile(envFile, now);
    if (!backup) {
      // 没有配置文件就没有可备份的东西；继续（这是"从未配置"的正常情形）。
      log('没有找到现有配置文件，按未配置处理');
    } else {
      log(`已备份原配置：${backup}`);
    }

    const entries = new Map<string, string>();
    if (backup) {
      for (const [key, value] of parseBootstrapFile(await readFile(envFile, 'utf8'))) {
        entries.set(key, value);
      }
    }

    // 业务连接键清空：下次提交必须重新填写，避免"重置了但还连着旧库"。
    for (const key of [
      'DATABASE_URL',
      'REDIS_URL',
      'STORAGE_DRIVER',
      'STORAGE_S3_ENDPOINT',
      'STORAGE_S3_REGION',
      'STORAGE_S3_BUCKET',
      'STORAGE_S3_ACCESS_KEY_ID',
      'STORAGE_S3_SECRET_ACCESS_KEY',
      'STORAGE_S3_FORCE_PATH_STYLE',
    ]) {
      entries.delete(key);
    }

    // 强制轮换认领令牌。
    const token = (options.generateToken ?? generateToken)();
    entries.set('STACKPANEL_SETUP_TOKEN', token);
    entries.set('STACKPANEL_BOOTSTRAP_STATE', 'provision');
    await writeFileAtomic(envFile, serializeBootstrapFile(entries), { mode: 0o640 });

    // 清掉候选（它们引用的可能是已被证明不可用的配置）。
    // 必须逐个文件名删除：`rm(prefix)` 只会尝试删一个字面叫 config.candidate- 的
    // 文件，静默失败，于是下一次 runner 仍会读到旧候选。
    const dir = bootstrapDir(layout);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (name.startsWith('config.candidate-') && name.endsWith('.env')) {
        await rm(path.join(dir, name), { force: true });
      }
    }

    // 清空任务通道：旧任务引用的是被否决的代次。保留会让 path unit
    // 在重置后立刻触发一次注定失败的迁移（审计 R3 的失败循环）。
    for (const channel of ['inbox', 'claimed']) {
      const root = path.join(dir, channel);
      for (const instance of await readdir(root).catch(() => [] as string[])) {
        const instanceDir = path.join(root, instance);
        for (const name of await readdir(instanceDir).catch(() => [] as string[])) {
          if (name.endsWith('.json')) await rm(path.join(instanceDir, name), { force: true });
        }
      }
    }

    await writeFileAtomic(
      statePath,
      `${JSON.stringify(
        {
          version: 1,
          phase: 'needs_infra',
          configGeneration: 0,
          ...(state.migrationSucceeded ? { migrationSucceeded: true } : {}),
          createdAt: now().toISOString(),
          updatedAt: now().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o640 },
    );

    return {
      ok: true,
      detail:
        '已回到 needs_infra。注意：数据库中已执行的迁移不会被回退；' +
        '重启后请在 /setup 重新填写基础设施，并使用新的初始化令牌。',
    };
  } finally {
    await lock.release().catch(() => undefined);
  }
}

/** 64 位 hex 令牌（32 字节熵），与安装脚本保持一致。 */
function generateToken(): string {
  return randomBytes(32).toString('hex');
}
