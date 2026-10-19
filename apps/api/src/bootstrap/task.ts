/**
 * 自举任务文件（审计 R3）。
 *
 * 为什么不能只靠 `state.json` 里的 `phase=queued` 来触发执行：
 * systemd path unit 只能监听**文件存在**，不能监听 JSON 字段变化。更重要的
 * 是审计指出的失败循环：如果触发文件在失败后仍留在 inbox，path unit 会在每次
 * 开机/重载时重新触发同一个已失败的迁移。
 *
 * 因此任务文件的生命周期被定义成：
 *
 * ```text
 * inbox/<instance>/<id>.json    ← API 原子写入（rename），path unit 唤醒
 * claimed/<instance>/<id>.json  ← runner 认领后立即移动（不再触发）
 * results/<instance>/<id>.json  ← 成功/失败都写结果，供诊断
 * ```
 *
 * 任务本身**不携带凭据**：只有操作 ID、配置代次与目标版本。真实配置在
 * `config.candidate-<generation>.env` 里，只有持有实例执行锁的 runner 才读它。
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';

/** 磁盘任务格式版本。 */
export const BOOTSTRAP_TASK_VERSION = 1;

export interface BootstrapTaskFile {
  version: number;
  /** 不透明操作 ID。 */
  id: string;
  /** 配置代次；runner 必须与 `state.json` 核对一致。 */
  configGeneration: number;
  /** 目标内核版本（迁移产物版本）。 */
  targetVersion: string;
  createdAt: string;
}

/** 三个目录的解析（与安装脚本创建的结构一致）。 */
export interface BootstrapChannelPaths {
  inbox: string;
  claimed: string;
  results: string;
}

export function bootstrapChannelPaths(stateDir: string, instanceId: string): BootstrapChannelPaths {
  const root = path.join(stateDir, 'bootstrap');
  return {
    inbox: path.join(root, 'inbox', instanceId),
    claimed: path.join(root, 'claimed', instanceId),
    results: path.join(root, 'results', instanceId),
  };
}

/** 创建全部通道目录（幂等）。 */
export async function ensureBootstrapChannel(paths: BootstrapChannelPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.inbox, { recursive: true }),
    mkdir(paths.claimed, { recursive: true }),
    mkdir(paths.results, { recursive: true }),
  ]);
}

/**
 * 发布任务：写临时文件 + rename 到 inbox。
 *
 * 必须 rename 而不是直接 write：path unit 会在文件刚创建、内容还没写完时
 * 就唤醒服务，runner 读到半个 JSON 会失败。原子 rename 保证「可见即可解析」。
 */
export async function publishBootstrapTask(
  paths: BootstrapChannelPaths,
  task: Omit<BootstrapTaskFile, 'version' | 'createdAt'> & { createdAt?: string },
): Promise<BootstrapTaskFile> {
  await ensureBootstrapChannel(paths);
  const full: BootstrapTaskFile = {
    version: BOOTSTRAP_TASK_VERSION,
    id: task.id,
    configGeneration: task.configGeneration,
    targetVersion: task.targetVersion,
    createdAt: task.createdAt ?? new Date().toISOString(),
  };
  const target = path.join(paths.inbox, `${full.id}.json`);
  const temp = path.join(paths.inbox, `.${full.id}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temp, `${JSON.stringify(full, null, 2)}\n`, 'utf8');
  await rename(temp, target);
  return full;
}

/** 认领任务：从 inbox 移到 claimed（同文件系统内的 rename）。 */
export async function claimBootstrapTask(
  paths: BootstrapChannelPaths,
  id: string,
): Promise<BootstrapTaskFile | null> {
  const from = path.join(paths.inbox, `${id}.json`);
  const to = path.join(paths.claimed, `${id}.json`);
  let raw: string;
  try {
    raw = await (await import('node:fs/promises')).readFile(from, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  await rename(from, to);
  const parsed = JSON.parse(raw) as BootstrapTaskFile;
  if (typeof parsed.configGeneration !== 'number' || typeof parsed.targetVersion !== 'string') {
    throw new Error(`自举任务文件格式非法：${from}`);
  }
  return parsed;
}

/** 认领 inbox 里的第一个任务（按文件名排序，保证确定性）。 */
export async function claimFirstBootstrapTask(
  paths: BootstrapChannelPaths,
): Promise<BootstrapTaskFile | null> {
  const names = (await readdir(paths.inbox).catch(() => [] as string[]))
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort();
  for (const name of names) {
    const claimed = await claimBootstrapTask(paths, name.slice(0, -'.json'.length));
    if (claimed) return claimed;
  }
  return null;
}

/**
 * 读取最近一次任务结果（诊断用）。
 *
 * 结果文件可能有很多（每次重试一份）；诊断只关心最新的一份，且必须
 * **容忍损坏**：一个坏文件不应让诊断接口整体 500。
 */
export async function readLatestBootstrapResult(
  paths: BootstrapChannelPaths,
): Promise<(Record<string, unknown> & { id?: string }) | null> {
  const names = (await readdir(paths.results).catch(() => [] as string[]))
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort()
    .reverse();
  for (const name of names) {
    try {
      const raw = await readFile(path.join(paths.results, name), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown> & { id?: string };
      }
    } catch {
      // 损坏或半写的文件：跳过，继续找更早的一份。
    }
  }
  return null;
}

/** 写结果（成功或失败都写），并清理 claimed 里的任务。 */
export async function finishBootstrapTask(
  paths: BootstrapChannelPaths,
  id: string,
  result: { ok: boolean; phase: string; detail?: string },
): Promise<void> {
  await mkdir(paths.results, { recursive: true });
  const payload = {
    id,
    ok: result.ok,
    phase: result.phase,
    ...(result.detail ? { detail: result.detail } : {}),
    finishedAt: new Date().toISOString(),
  };
  const target = path.join(paths.results, `${id}.json`);
  const temp = path.join(paths.results, `.${id}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(temp, target);
  await rm(path.join(paths.claimed, `${id}.json`), { force: true });
}
