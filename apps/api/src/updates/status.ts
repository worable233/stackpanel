/**
 * 读取 updater 状态投影（PLAN-github-distribution-and-updates §5.2）。
 *
 * 更新中心展示「当前部署代次、正在执行的任务、最近结果」时读这份投影；updater 不在线
 * 时读取失败只返回 null（页面照常渲染，不阻塞、不出网）。权威状态仍在 updater 卷。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { UpdateTaskResult } from '@stackpanel/spec';
import { env } from '../config/env.ts';
import { updateChannelRoot } from './runtime.ts';

export interface UpdaterStatus {
  generation: number;
  digest: string | null;
  activeTask: string | null;
  recent: Array<{ idempotencyKey: string; result: UpdateTaskResult }>;
  updatedAt: string;
}

/**
 * updater 共享状态卷根目录（状态投影、自升级请求、通道都在这个卷上）。
 *
 * 优先显式 `DISTRIBUTION_UPDATER_STATE_DIR`，否则退回通道根目录的上一级
 * （`docker-compose.yml` 把两者挂在同一个 `stackpanel-updater-state` 卷）。
 */
export function updaterStateDir(): string {
  if (stateDirOverride) return stateDirOverride;
  if (env.DISTRIBUTION_UPDATER_STATE_DIR) return env.DISTRIBUTION_UPDATER_STATE_DIR;
  return path.dirname(updateChannelRoot());
}

/** 测试注入状态卷根（与 `setUpdateChannelForTest` 同风格）；生产恒为 null。 */
let stateDirOverride: string | null = null;

/** 测试用：覆盖 updater 状态卷根；不传则清除覆盖。 */
export function setUpdaterStateDirForTest(dir: string | null): void {
  stateDirOverride = dir;
}

/** updater 状态投影路径：与通道同卷；由 `DISTRIBUTION_UPDATER_STATUS_FILE` 覆盖。 */
export function updaterStatusPath(): string {
  if (env.DISTRIBUTION_UPDATER_STATUS_FILE) return env.DISTRIBUTION_UPDATER_STATUS_FILE;
  return path.join(updaterStateDir(), 'status.json');
}

/** 读取状态投影；缺失/损坏即返回 null（页面不阻塞、不出网）。 */
export async function readUpdaterStatus(): Promise<UpdaterStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(updaterStatusPath(), 'utf8')) as UpdaterStatus;
    return typeof parsed.generation === 'number' ? parsed : null;
  } catch {
    return null;
  }
}
