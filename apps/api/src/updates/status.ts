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

/** updater 状态投影路径：与通道同卷；由 `DISTRIBUTION_UPDATER_STATUS_FILE` 覆盖。 */
export function updaterStatusPath(): string {
  if (env.DISTRIBUTION_UPDATER_STATUS_FILE) return env.DISTRIBUTION_UPDATER_STATUS_FILE;
  // 通道根目录的上一级（updater 状态卷根）下的 status.json。
  return path.join(path.dirname(updateChannelRoot()), 'status.json');
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
