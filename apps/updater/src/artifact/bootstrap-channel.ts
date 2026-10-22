/**
 * 自举任务通道（runner 侧，审计 R3）。
 *
 * 与内核 `apps/api/src/bootstrap/task.ts` 是同一套目录协议：
 *
 * ```text
 * inbox/<instance>/<id>.json    ← API 原子 rename 写入，path unit 唤醒
 * claimed/<instance>/<id>.json  ← runner 认领后立即移出（不再触发）
 * results/<instance>/<id>.json  ← 成功/失败都写结果
 * ```
 *
 * 两个实现是刻意的：runner 是独立发布的可执行体，不能 import 内核源码树。
 * 协议本身很小（文件名 + 三个字段），风险在于"两边对目录或字段理解不一致"，
 * 因此两侧都用同一组常量与字段名，并由 `bootstrap-channel.test.ts` 覆盖
 * 认领/清理/失败不留触发文件这三条不变量。
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const BOOTSTRAP_TASK_VERSION = 1;

export interface BootstrapTaskFile {
  version: number;
  id: string;
  configGeneration: number;
  targetVersion: string;
  createdAt: string;
}

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

export async function ensureBootstrapChannel(paths: BootstrapChannelPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.inbox, { recursive: true }),
    mkdir(paths.claimed, { recursive: true }),
    mkdir(paths.results, { recursive: true }),
  ]);
}

/**
 * 认领 inbox 里的第一个任务。
 *
 * 顺序：读 → **rename 移出 inbox** → 解析。
 * 先移出再解析是刻意的：即使 JSON 损坏，任务也不会留在 inbox 形成触发循环；
 * 损坏的任务会以失败结果暴露出来，而不是让 path unit 反复唤醒。
 */
export async function claimFirstBootstrapTask(
  paths: BootstrapChannelPaths,
): Promise<{ task: BootstrapTaskFile; file: string } | null> {
  // `claimed/` 可能还不存在（旧安装、手工建目录）：不先建好，rename 会以
  // ENOENT 失败，而下面的分支会把它误判成「另一个执行者刚抢走」——
  // 任务永远留在 inbox，systemd 反复唤醒，实例卡在 queued。
  await ensureBootstrapChannel(paths);
  const names = (await readdir(paths.inbox).catch(() => [] as string[]))
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort();
  for (const name of names) {
    const from = path.join(paths.inbox, name);
    const to = path.join(paths.claimed, name);
    try {
      await rename(from, to);
    } catch (error) {
      // 另一个执行者刚刚认领了它：继续看下一个。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const raw = await readFile(to, 'utf8');
    let parsed: BootstrapTaskFile;
    try {
      parsed = JSON.parse(raw) as BootstrapTaskFile;
    } catch {
      throw new Error(`自举任务文件不是合法 JSON：${to}`);
    }
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.configGeneration !== 'number' ||
      typeof parsed.targetVersion !== 'string'
    ) {
      throw new Error(`自举任务文件字段非法：${to}`);
    }
    return { task: parsed, file: to };
  }
  return null;
}

/** 写结果并从 claimed 清理；失败也要写（否则无法诊断为什么卡住）。 */
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

