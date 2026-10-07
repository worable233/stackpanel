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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REDIS_KEY_PREFIX } from '@stackpanel/sdk';
import { findRepoRoot } from '@stackpanel/sdk/paths';
import type { RedisClient } from '@stackpanel/db';
import { getEventBus } from '../plugins/events.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { KernelNotificationsService } from '../notifications/notifications-service.ts';
import {
  createFrontendApplyNotifier,
  type FrontendApplyNotifier,
  type FrontendApplyStatusInput,
} from '../notifications/frontend-apply-notifications.ts';
import {
  readFrontendApplyRequest,
  writeFrontendApplyStatus,
  writeFrontendAppliedSignature,
  clearFrontendApplyRequest,
  computeFrontendSignature,
  readFrontendAppliedSignature,
  isFrontendDevBuild,
  frontendApplySteps,
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

/**
 * Repo root, discovered from this module's location rather than `process.cwd()`.
 *
 * In dev each workspace runs with its own cwd (`apps/api`, `apps/web`, ...), so
 * `process.cwd()` is not the monorepo root and `pnpm build:frontend` would not
 * resolve. Discovery walks up to `pnpm-workspace.yaml`, matching `@stackpanel/sdk`.
 * In the container the module lives at `/app/apps/api/dist`, whose repo root is
 * `/app` too, so this is correct there as well.
 */
function repoRoot(): string {
  return findRepoRoot(path.dirname(fileURLToPath(import.meta.url))) ?? process.cwd();
}

interface StreamingResult {
  code: number;
}

/** Command runner seam so the build steps can be unit-tested without spawning. */
export type FrontendCommandRunner = (
  command: string,
  args: string[],
  label: string,
  onLine?: (line: string) => void,
) => Promise<StreamingResult>;

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

export interface FrontendBuildDeps {
  /** Command runner seam (tests). Defaults to {@link runStreaming}. */
  runCommand?: FrontendCommandRunner;
  /** Override dev detection (tests). Defaults to {@link isFrontendDevBuild}. */
  dev?: boolean;
  /**
   * Live-notification sink. Defaults to a kernel notification writer, but only
   * when the request has an actor (`requestedBy`); a null actor (boot reconcile)
   * or an injected notifier (tests) skips it. Failures never fail the build.
   */
  notifier?: FrontendApplyNotifier;
}

/** Build the default notifier from the kernel DB/event singletons. */
function defaultFrontendApplyNotifier(): FrontendApplyNotifier {
  return createFrontendApplyNotifier({
    notifications: new KernelNotificationsService({
      db: getPrisma(),
      events: getEventBus(),
    }),
  });
}

export async function runFrontendBuild(
  request: FrontendApplyRequest,
  deps: FrontendBuildDeps = {},
): Promise<void> {
  if (building) return;
  building = true;
  try {
    await runFrontendBuildUnsafe(request, deps);
  } finally {
    building = false;
  }
}

async function runFrontendBuildUnsafe(
  request: FrontendApplyRequest,
  deps: FrontendBuildDeps,
): Promise<void> {
  const runCommand = deps.runCommand ?? runStreaming;
  const dev = deps.dev ?? isFrontendDevBuild();
  // Only a request with a known actor produces a live notification; the boot
  // reconcile (requestedBy null) and actor-less requests stay silent, and tests
  // without an injected notifier never touch the DB.
  const notifier =
    deps.notifier ?? (request.requestedBy ? defaultFrontendApplyNotifier() : null);
  const steps = request.steps ?? [
    '停止当前服务',
    request.action === 'remove' ? '移除前端资源' : '编译前端资源',
    '生成前端产物',
    '重启服务',
  ];
  const total = steps.length;
  const subject = request.label ? `「${request.label}」` : '';

  // Write both the on-disk status (admin progress card) and the live
  // notification (cross-page bell). Both are best-effort by contract.
  const emit = async (status: Omit<FrontendApplyStatusInput, 'at'>): Promise<void> => {
    await writeFrontendApplyStatus(status);
    if (notifier) await notifier(request, status);
  };

  const progress = (step: number, detail: string): Promise<void> =>
    emit({
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
    // Step numbers follow the plan: prod is [stop, compile, artifacts, restart]
    // (compile=2); dev is [compile, artifacts] (compile=1, no service steps).
    const compileStep = dev ? 1 : 2;
    const artifactsStep = compileStep + 1;
    await progress(compileStep, steps[compileStep - 1] ?? '编译前端资源');
    const registry = await runCommand('pnpm', ['build:frontend'], 'build:frontend', (line) => {
      const buildingMatch = /^Building frontend (.+?)(?:…|\.\.\.)?\s*$/.exec(line);
      if (buildingMatch) void progress(compileStep, `正在编译 ${buildingMatch[1]}`);
    });
    if (registry.code !== 0) {
      failed = '前端资源编译失败';
    } else if (!dev) {
      // Production: build the Next bundle the web replicas serve. In dev the
      // running `next dev` hot-reloads the regenerated registry on its own, and
      // `next build` would collide with it over `.next`.
      await progress(artifactsStep, steps[artifactsStep - 1] ?? '生成前端产物');
      const web = await runCommand('pnpm', ['--filter', '@stackpanel/web', 'build'], 'next build');
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

  await emit({
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
      steps: frontendApplySteps({ target: 'plugin', action: 'update', rebuild: true }),
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
