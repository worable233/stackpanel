import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { peekRedis } from '@stackpanel/db';
import { REDIS_KEY_PREFIX } from '@stackpanel/sdk';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { notifyFrontendApplyQueued } from '../notifications/frontend-apply-notifications.ts';

/**
 * 插件/主题前端「应用」信号（kernel → web 容器）。
 *
 * 前端产物（`data/**\/frontend/dist`）虽然已经落盘，但 web 用的是一个由
 * `pnpm build:frontend` 生成的静态 registry，必须重新构建才能真正加载。这里
 * 不在 API 进程里跑构建（Docker 下 web 是独立容器），而是写两个文件到共享的
 * 数据目录，由 web 容器的 supervisor 消费：
 *
 *   - `request.json`：API 侧写下的「需要重建」请求（含原因/时间戳）
 *   - `status.json` ：web 侧 supervisor 写下的构建/重启进展（含分步进度，供后台展示）
 *
 * 因为目录是两容器共享的卷，web 重启后依然能看到未消费的请求。
 */

export type FrontendApplyState = 'pending' | 'building' | 'restarting' | 'succeeded' | 'failed';

const FRONTEND_APPLY_STATES = new Set<FrontendApplyState>([
  'pending',
  'building',
  'restarting',
  'succeeded',
  'failed',
]);

export interface FrontendApplyRequest {
  requestedAt: string;
  requestedBy: string | null;
  /** 机器可读的原因，如 `plugin.install` / `theme.remove`。 */
  reason: string;
  /** 人类可读的变更对象名（插件/主题名），用于进度文案。 */
  label?: string;
  /** 目标类型，决定进度步骤集合。 */
  target: 'plugin' | 'theme';
  /** 变更动作，决定进度步骤集合。 */
  action: FrontendApplyAction;
  /** 本次应用的步骤名称（按序）。由 API 生成，supervisor 直接采用。 */
  steps?: string[];
  /** 缺少前端产物时 supervisor 只重启不重建。 */
  rebuild: boolean;
}

export type FrontendApplyAction = 'install' | 'update' | 'remove';

/**
 * Whether this is a single-process development stack.
 *
 * The frontend builder's ownership already turns on Redis: with Redis a
 * dedicated worker is the single builder (S7 / ADR-0017 §5); without Redis
 * there is no worker and the API process itself is the sole job owner, so it
 * also owns the builder. The same signal decides the *build shape*: a
 * single-process stack serves the app with `next dev`, which hot-reloads the
 * regenerated registry, so no `next build` / restart is needed (and `next
 * build` would fight the live dev server over `.next`). Production (Redis
 * present, `next start` behind the supervisor) runs the full build.
 *
 * `NODE_ENV` is deliberately not used: the PM2 deployment serves built
 * artifacts while running with `NODE_ENV=development`, so it must still build.
 */
export function isFrontendDevBuild(): boolean {
  return peekRedis() === null;
}

/**
 * Progress plan for a user-triggered apply. Owned here so the API can surface
 * the same steps to the UI while the request is still queued; the builder reads
 * them from the request file and reports against them.
 */
export function frontendApplySteps(input: {
  target: 'plugin' | 'theme';
  action: FrontendApplyAction;
  rebuild: boolean;
  /** Override dev detection (tests). Defaults to {@link isFrontendDevBuild}. */
  dev?: boolean;
}): string[] {
  if (!input.rebuild) return ['停止当前服务', '重启服务'];
  const noun = input.target === 'theme' ? '主题' : '插件';
  const second = input.action === 'remove' ? `移除${noun}前端资源` : `编译${noun}前端资源`;
  // Single-process dev: only the registry is regenerated; the dev server
  // hot-reloads. No service stop/restart steps apply.
  if (input.dev ?? isFrontendDevBuild()) {
    return [second, '生成前端产物'];
  }
  return ['停止当前服务', second, '生成前端产物', '重启服务'];
}

export interface FrontendApplyStatus {
  state: FrontendApplyState;
  /** 状态写入时间（ISO）。 */
  at: string;
  /** 状态对应的请求时间，用于判断是否已处理完最新请求。 */
  requestedAt: string | null;
  /** 人类可读的变更对象名。 */
  label?: string;
  /** 目标类型/动作，供前端渲染步骤文案。 */
  target?: 'plugin' | 'theme';
  action?: FrontendApplyAction;
  /** 当前步骤（1-based）。 */
  step?: number;
  /** 本次应用的步骤名称（按序），供前端渲染步骤列表。 */
  steps?: string[];
  /** 当前正在做的事（一行短语）。 */
  detail?: string;
  message?: string;
}

function dataDir(): string {
  return resolveStackPanelDataDir();
}

function requestPath(): string {
  return path.join(dataDir(), 'frontend-apply.request.json');
}

function statusPath(): string {
  return path.join(dataDir(), 'frontend-apply.status.json');
}

/** Records the frontend signature of the last successful build (shared volume). */
export function frontendSignaturePath(): string {
  return path.join(dataDir(), 'frontend-apply.signature');
}

/** Frontend package roots mirrored by `scripts/build-frontend.mjs`. */
function frontendGroups(): Array<{ kind: string; root: string }> {
  return [
    { kind: 'themes', root: path.join(dataDir(), 'themes') },
    { kind: 'plugins', root: path.join(dataDir(), 'plugins') },
  ];
}

/**
 * Signature of the on-disk frontend packages, shared by the builder (worker)
 * and the consumers (web replicas). Stable, and changes whenever a plugin or
 * theme frontend is added, removed or upgraded. `count` is the number of
 * frontend packages found (0 => nothing to apply).
 */
export async function computeFrontendSignature(): Promise<{
  signature: string;
  count: number;
}> {
  const entries: string[] = [];
  for (const group of frontendGroups()) {
    let ids: string[];
    try {
      ids = await readdir(group.root);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (id.startsWith('.')) continue;
      const manifest = path.join(group.root, id, 'frontend', 'manifest.json');
      let version: string;
      try {
        const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { version?: unknown };
        version = typeof parsed.version === 'string' ? parsed.version : '';
      } catch {
        continue;
      }
      entries.push(`${group.kind}/${id}@${version}`);
    }
  }
  entries.sort();
  return {
    signature: createHash('sha256').update(entries.join('\n')).digest('hex'),
    count: entries.length,
  };
}

/** The signature recorded after the last successful build, or null. */
export async function readFrontendAppliedSignature(): Promise<string | null> {
  try {
    return (await readFile(frontendSignaturePath(), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

/** Record the current on-disk frontend signature after a successful build. */
export async function writeFrontendAppliedSignature(signature?: string): Promise<void> {
  const value = signature ?? (await computeFrontendSignature()).signature;
  const target = frontendSignaturePath();
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${value}\n`, 'utf8');
  await rename(tmp, target);
}

/** Atomically write the apply status consumed by the admin progress UI. */
export async function writeFrontendApplyStatus(
  status: Omit<FrontendApplyStatus, 'at'>,
): Promise<void> {
  const payload = { ...status, at: new Date().toISOString() };
  const target = statusPath();
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
}

/** Remove a consumed build request file. */
export async function clearFrontendApplyRequest(): Promise<void> {
  await rm(requestPath(), { force: true });
}

/**
 * 请求 web 端重建并重启前端。写请求文件（原子替换），由 supervisor 消费。
 * 缺前端源码/构建工具时仍会写请求，supervisor 会退化为「仅重启」。
 */
export async function requestFrontendApply(input: {
  reason: string;
  requestedBy: string | null;
  target: 'plugin' | 'theme';
  action: FrontendApplyAction;
  label?: string;
  rebuild: boolean;
}): Promise<FrontendApplyRequest> {
  const request: FrontendApplyRequest = {
    requestedAt: new Date().toISOString(),
    requestedBy: input.requestedBy,
    reason: input.reason,
    target: input.target,
    action: input.action,
    ...(input.label ? { label: input.label } : {}),
    steps: frontendApplySteps({
      target: input.target,
      action: input.action,
      rebuild: input.rebuild,
    }),
    rebuild: input.rebuild,
  };
  const target = requestPath();
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
  // Surface the activity in the bell immediately, before the builder's first
  // `building` update. Best-effort: a notification must never break the apply.
  try {
    await notifyFrontendApplyQueued(request);
  } catch {
    // The builder's progress updates will create the live notification anyway.
  }
  // Nudge the worker (single builder) for low latency; the durable request file
  // is the fallback trigger, so this is best-effort (no Redis in dev).
  const redis = peekRedis();
  if (redis) {
    try {
      await redis.publish(`${REDIS_KEY_PREFIX.runtime}frontend-build`, 'pending');
    } catch {
      // The worker's poll loop will pick the request up.
    }
  }
  return request;
}

/** 读取 supervisor 写下的最新状态；缺失/损坏时返回 null。 */
export async function readFrontendApplyStatus(): Promise<FrontendApplyStatus | null> {
  try {
    const raw = await readFile(statusPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<FrontendApplyStatus>;
    if (typeof parsed.state !== 'string' || typeof parsed.at !== 'string') return null;
    if (!FRONTEND_APPLY_STATES.has(parsed.state as FrontendApplyState)) return null;
    return {
      state: parsed.state as FrontendApplyState,
      at: parsed.at,
      requestedAt: typeof parsed.requestedAt === 'string' ? parsed.requestedAt : null,
      ...(typeof parsed.label === 'string' ? { label: parsed.label } : {}),
      ...(parsed.target === 'plugin' || parsed.target === 'theme' ? { target: parsed.target } : {}),
      ...(parsed.action === 'install' || parsed.action === 'update' || parsed.action === 'remove'
        ? { action: parsed.action }
        : {}),
      ...(typeof parsed.step === 'number' ? { step: parsed.step } : {}),
      ...(Array.isArray(parsed.steps) && parsed.steps.every((s) => typeof s === 'string')
        ? { steps: parsed.steps as string[] }
        : {}),
      ...(typeof parsed.detail === 'string' ? { detail: parsed.detail } : {}),
      ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
    };
  } catch {
    return null;
  }
}

/** 读取尚未被消费的重建请求；缺失/损坏时返回 null。 */
export async function readFrontendApplyRequest(): Promise<FrontendApplyRequest | null> {
  try {
    const raw = await readFile(requestPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<FrontendApplyRequest>;
    if (typeof parsed.requestedAt !== 'string' || typeof parsed.reason !== 'string') return null;
    return {
      requestedAt: parsed.requestedAt,
      requestedBy: typeof parsed.requestedBy === 'string' ? parsed.requestedBy : null,
      reason: parsed.reason,
      rebuild: parsed.rebuild !== false,
      target: parsed.target === 'theme' ? 'theme' : 'plugin',
      action: parsed.action === 'update' || parsed.action === 'remove' ? parsed.action : 'install',
      ...(Array.isArray(parsed.steps) && parsed.steps.every((s) => typeof s === 'string')
        ? { steps: parsed.steps as string[] }
        : {}),
      ...(typeof parsed.label === 'string' ? { label: parsed.label } : {}),
    };
  } catch {
    return null;
  }
}

/** 测试/运维用：清除请求与状态文件。 */
export async function clearFrontendApply(): Promise<void> {
  await rm(requestPath(), { force: true });
  await rm(statusPath(), { force: true });
}
