/**
 * Frontend build orchestration (S7 / ADR-0017 §5).
 *
 * Historically every web container rebuilt the web bundle itself: the API wrote
 * `data/frontend-apply.request.json` onto the shared volume and each
 * `frontend-supervisor` polled it and ran `pnpm build:frontend` + `next build`.
 * With N replicas that is N identical builds racing on the same source.
 *
 * S7 makes the **worker the single builder**:
 *
 *   1. A plugin/theme change writes the durable request file (as before).
 *   2. The worker (and only the worker) watches that file, runs the build once
 *      and writes a new artifact signature.
 *   3. Each web replica sees the new signature and restarts itself only.
 *
 * The durable trigger is the request file on the shared volume; a Redis Pub/Sub
 * nudge (`sp:runtime:frontend-build`, reusing the runtime namespace) keeps the
 * latency low. Without Redis the worker still polls, so development works.
 *
 * The `next build` output must be visible to the web containers, so the worker
 * and web services share a named volume mounted at `apps/web/.next`
 * (`stackpanel-web-build`, see docker-compose*.yml). Single build, N web
 * restarts, no replica ever builds.
 *
 * The progress-UI contract is unchanged: the builder writes the same
 * `frontend-apply.status.json` fields the old supervisor wrote.
 */
import { spawn } from 'node:child_process';
import { REDIS_KEY_PREFIX } from '@stackpanel/sdk';
import type { RedisClient } from '@stackpanel/db';
import {
  readFrontendApplyRequest,
  writeFrontendApplyStatus,
  writeFrontendAppliedSignature,
  clearFrontendApplyRequest,
  computeFrontendSignature,
  readFrontendAppliedSignature,
  type FrontendApplyRequest,
} from './frontend-apply.ts';

/** Whether automated frontend application is enabled. */
export function frontendAutobuildEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['STACKPANEL_FRONTEND_AUTOBUILD'] !== '0';
}

/** Pub/Sub channel notifying the builder that a request is waiting. */
export function frontendBuildChannel(): string {
  return `${REDIS_KEY_PREFIX.runtime}frontend-build`;
}

/** Repo root (the process working directory in dev and in the container). */
function repoRoot(): string {
  return process.cwd();
}

interface StreamingResult {
  code: number;
}

/** Run a command, forwarding output and reporting each line to `onLine`. */
function runStreaming(
  command: string,
  args: string[],
  label: string,
  onLine?: (line: string) => void,
): Promise<StreamingResult> {
  return new Promise((resolve) => {
    console.log(`[frontend-build] ${label}…`);
    const proc = spawn(command, args, { cwd: repoRoot(), env: process.env });
    const handle = (chunk: Buffer): void => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (!onLine) return;
      for (const line of text.split(/\r?\n/)) {
        if (line) onLine(line);
      }
    };
    proc.stdout?.on('data', handle);
    proc.stderr?.on('data', handle);
    proc.on('exit', (code) => resolve({ code: code ?? 1 }));
    proc.on('error', (error) => {
      console.error(`[frontend-build] ${label} 启动失败：${error.message}`);
      resolve({ code: 1 });
    });
  });
}

/**
 * Notify the builder that a request is pending (kept for callers that do not go
 * through `requestFrontendApply`). Best-effort; the request file is durable.
 */
export async function nudgeFrontendBuild(redis: RedisClient | null): Promise<void> {
  if (!frontendAutobuildEnabled() || !redis) return;
  try {
    await redis.publish(frontendBuildChannel(), 'pending');
  } catch {
    // The durable request file remains the trigger.
  }
}

/**
 * Execute one frontend build. Guarded by a local flag; the worker is expected
 * to be the only process that calls this, so no cross-process lock is needed.
 * Never throws to the caller: a failed build reports `failed` and keeps the
 * previous artifacts in place.
 */
let building = false;

export async function runFrontendBuild(request: FrontendApplyRequest): Promise<void> {
  if (building) return;
  building = true;
  try {
    await runFrontendBuildUnsafe(request);
  } finally {
    building = false;
  }
}

async function runFrontendBuildUnsafe(request: FrontendApplyRequest): Promise<void> {
  const steps = request.steps ?? [
    '停止当前服务',
    request.action === 'remove' ? '移除前端资源' : '编译前端资源',
    '生成前端产物',
    '重启服务',
  ];
  const total = steps.length;
  const subject = request.label ? `「${request.label}」` : '';

  const progress = (step: number, detail: string): Promise<void> =>
    writeFrontendApplyStatus({
      state: 'building',
      requestedAt: request.requestedAt,
      ...(request.label ? { label: request.label } : {}),
      target: request.target,
      action: request.action,
      step,
      steps,
      detail,
    });

  let failed: string | null = null;
  if (request.rebuild) {
    await progress(2, steps[1] ?? '编译前端资源');
    const registry = await runStreaming('pnpm', ['build:frontend'], 'build:frontend', (line) => {
      const buildingMatch = /^Building frontend (.+?)(?:…|\.\.\.)?\s*$/.exec(line);
      if (buildingMatch) void progress(2, `正在编译 ${buildingMatch[1]}`);
    });
    if (registry.code !== 0) {
      failed = '前端资源编译失败';
    } else {
      await progress(3, steps[2] ?? '生成前端产物');
      const web = await runStreaming('pnpm', ['--filter', '@stackpanel/web', 'build'], 'next build');
      if (web.code !== 0) failed = 'Web 构建失败';
    }
  }

  if (!failed) {
    try {
      await writeFrontendAppliedSignature();
    } catch (error) {
      console.warn(
        `[frontend-build] 写入签名失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await clearFrontendApplyRequest();

  await writeFrontendApplyStatus({
    state: failed ? 'failed' : 'succeeded',
    requestedAt: request.requestedAt,
    ...(request.label ? { label: request.label } : {}),
    target: request.target,
    action: request.action,
    step: total,
    steps,
    detail: failed ?? '已完成',
    message: failed ? `前端变更未生效：${failed}` : `${subject}已生效`,
  });
  console.log(`[frontend-build] ${failed ? `失败：${failed}` : '完成'}`);
}

export interface FrontendBuilderOptions {
  /** Shared Redis client (nudge subscription). Null in dev without Redis. */
  redis: RedisClient | null;
  /** Poll interval in ms; the durable fallback trigger. Defaults to 2000. */
  intervalMs?: number;
  /** Build runner seam (tests). Defaults to {@link runFrontendBuild}. */
  runBuild?: (request: FrontendApplyRequest) => Promise<void>;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}

/**
 * Worker-owned builder loop. Runs only in the worker process. Consumes pending
 * requests from the shared volume, nudged by Redis Pub/Sub for low latency.
 */
export class FrontendBuilder {
  private subscriber: RedisClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly options: FrontendBuilderOptions) {}

  start(): void {
    if (!frontendAutobuildEnabled()) {
      this.options.logger?.info('[frontend-build] 自动构建已关闭（STACKPANEL_FRONTEND_AUTOBUILD=0）');
      return;
    }
    const interval = this.options.intervalMs ?? 2000;
    this.timer = setInterval(() => {
      void this.drain();
    }, interval);
    this.timer.unref?.();
    void this.subscribe();
    void this.reconcileOnBoot();
    this.options.logger?.info('[frontend-build] 已启动单一构建者（worker）');
  }

  /**
   * On boot, if the shared data directory contains frontend packages that the
   * current bundle does not reflect, build once. This covers a fresh web-build
   * volume (plugin packages restored from the data volume before the first
   * build) and a worker restart after a missed request.
   */
  private async reconcileOnBoot(): Promise<void> {
    try {
      const [current, applied] = await Promise.all([
        computeFrontendSignature(),
        readFrontendAppliedSignature(),
      ]);
      if (current.count > 0 && current.signature !== applied) {
        this.options.logger?.info(
          `[frontend-build] 启动对账：${applied ?? 'none'} -> ${current.signature}（${current.count} 个包）`,
        );
        await this.buildBootReconcile();
      }
    } catch (error) {
      this.options.logger?.warn(
        `[frontend-build] 启动对账失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async buildBootReconcile(): Promise<void> {
    await (this.options.runBuild ?? runFrontendBuild)({
      requestedAt: new Date().toISOString(),
      requestedBy: null,
      reason: 'boot-reconcile',
      target: 'plugin',
      action: 'update',
      rebuild: true,
      steps: ['停止当前服务', '编译前端资源', '生成前端产物', '重启服务'],
    });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => undefined);
      this.subscriber = null;
    }
  }

  private async subscribe(): Promise<void> {
    const redis = this.options.redis;
    if (!redis || this.subscriber) return;
    this.subscriber = redis.duplicate();
    await this.subscriber.subscribe(frontendBuildChannel());
    this.subscriber.on('message', () => {
      void this.drain();
    });
  }

  /** Build the pending request, if any. Re-entrancy guarded. */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const request = await readFrontendApplyRequest();
      if (!request) {
        return;
      }
      await (this.options.runBuild ?? runFrontendBuild)(request);
    } catch (error) {
      this.options.logger?.warn(
        `[frontend-build] 构建失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
