/**
 * Job subsystem entry points (S6 / ADR-0013).
 *
 * `initJobs()` attaches a storage backend to the canonical runtime: BullMQ when
 * Redis is configured, the in-process fallback otherwise. `registerKernelSweeps`
 * registers the platform's own recurring work (state/payment/outbox) as kernel
 * jobs so it runs once across the cluster.
 */
import { Queue } from 'bullmq';
import { REDIS_KEY_PREFIX } from '@stackpanel/sdk';
import type { JobContext } from '@stackpanel/sdk';
import { redisConnectionOptions } from './redis-connection.ts';
import { getJobRuntime, KERNEL_JOBS } from './kernel-jobs.ts';
import { BullMqJobBackend, KERNEL_QUEUE_NAME } from './bullmq-backend.ts';
import { MemoryJobBackend } from './memory-backend.ts';

export { createKernelJobContext, getJobRuntime, KERNEL_JOBS, qualify } from './kernel-jobs.ts';
export type { JobBackend, JobRuntime, RegisteredSchedule } from './types.ts';
export { KERNEL_QUEUE_NAME } from './bullmq-backend.ts';

export interface InitJobsOptions {
  /** Configured Redis URL; null in development means the in-process fallback. */
  redisUrl: string | null;
  logger: { info: (m: string) => void; warn: (m: string) => void };
}

/**
 * Attach the active backend to the process-wide runtime and start consuming.
 * Called from `initInfra()` once Redis is known. Idempotent.
 */
export async function initJobs(options: InitJobsOptions): Promise<void> {
  const runtime = getJobRuntime();
  if (options.redisUrl) {
    await runtime.useBackend(
      new BullMqJobBackend({
        redisUrl: options.redisUrl,
        logger: options.logger,
        onUnknownJob: (fullName) =>
          options.logger.warn(`[jobs] 本副本无处理器，任务回退重试：${fullName}`),
      }),
    );
    options.logger.info('[jobs] 已启用 Redis/BullMQ 任务后端（集群安全）');
  } else {
    // Losing Redis is not fatal to boot, but it silently downgrades scheduled
    // work (payment/outbox/state sweeps) to a per-process timer and **drops**
    // cron declarations entirely — so make the degradation loud, not a footnote
    // (audit E-10). The warning below is currently the *only* place operators
    // can see it: `/ready` does not report the job backend (its flat
    // `ok|unreachable|disabled` check map has no room for it), so do not
    // remove this log line without adding that signal elsewhere first.
    options.logger.warn(
      '[jobs] 未配置 Redis：任务使用进程内实现，cron 计划任务将被忽略、且仅单副本正确。生产环境请配置 REDIS_URL。',
    );
    await runtime.useBackend(new MemoryJobBackend({ logger: options.logger }));
  }
  await runtime.start();
}

export interface KernelSweepDeps {
  /** Drop expired in-process state keys (no-op under Redis). */
  stateSweep: () => void;
  /** Cancel expired external payments and release their orders. */
  paymentSweep: () => Promise<void>;
  /** Relay undelivered outbox rows (crash recovery / cross-node fan-out). */
  outboxRelay: () => Promise<void>;
  /** Trim delivered outbox rows; runs on a slow cadence. */
  outboxCleanup: () => Promise<void>;
  /** Return expired wallet holds to the balance (ADR-0022 P16). */
  walletHoldSweep: () => Promise<void>;
  /** Retry due external-notification channel deliveries (audit §5). */
  notificationDeliverySweep: () => Promise<void>;
  /** 目录刷新（PLAN §10）。缺省为无操作：显式关闭目录源的实例完全离线。 */
  catalogRefresh?: () => Promise<void>;
  /** 自动更新评估（§13-6）。缺省为无操作：目录源关闭或策略关闭时完全离线。 */
  autoUpdate?: () => Promise<void>;
  /** 清理已过期的限时权限组成员关系（会员权益）。缺省不注册。 */
  membershipSweep?: () => Promise<void>;
  logger: { warn: (m: string) => void };
}

/** Fixed intervals for kernel sweeps. */
const STATE_SWEEP_MS = 60_000;
const PAYMENT_SWEEP_MS = 5 * 60_000;
const WALLET_HOLD_SWEEP_MS = 60_000;
const OUTBOX_RELAY_MS = 2_000;
/** Retry external-notification deliveries every 30s. */
const NOTIFICATION_DELIVERY_SWEEP_MS = 30_000;
/** Run outbox retention roughly hourly (every N relay passes). */
const OUTBOX_CLEANUP_EVERY = Math.max(1, Math.round((60 * 60_000) / OUTBOX_RELAY_MS));
/** §10: catalog refresh cadence (jitter applied by the service's `isDue`). */
const CATALOG_REFRESH_MS = 6 * 60 * 60_000;
/** 会员权益到期清理：每小时。过期判定在读路径，频率只影响清理及时性。 */
const MEMBERSHIP_SWEEP_MS = 60 * 60_000;

/**
 * Register the kernel's recurring jobs. Missing handlers are simply absent on a
 * replica that does not own the work; BullMQ retries are bounded so a job with
 * no handler never loops forever.
 */
export async function registerKernelSweeps(
  jobs: JobContext,
  deps: KernelSweepDeps,
): Promise<void> {
  jobs.handle(KERNEL_JOBS.stateSweep, async () => {
    deps.stateSweep();
  });
  jobs.handle(KERNEL_JOBS.paymentSweep, async () => {
    await deps.paymentSweep();
  });
  jobs.handle(KERNEL_JOBS.walletHoldSweep, async () => {
    await deps.walletHoldSweep();
  });
  jobs.handle(KERNEL_JOBS.notificationDeliverySweep, async () => {
    await deps.notificationDeliverySweep();
  });
  let outboxPasses = 0;
  jobs.handle(KERNEL_JOBS.outboxRelay, async () => {
    await deps.outboxRelay();
    outboxPasses += 1;
    if (outboxPasses % OUTBOX_CLEANUP_EVERY === 0) {
      await deps.outboxCleanup().catch((err: unknown) => {
        deps.logger.warn(`[jobs] outbox cleanup failed: ${String(err)}`);
      });
    }
  });

  await jobs.schedule('state.sweep', { everyMs: STATE_SWEEP_MS }, undefined);
  await jobs.schedule('payments.sweep-expired', { everyMs: PAYMENT_SWEEP_MS }, undefined);
  await jobs.schedule('wallet.sweep-holds', { everyMs: WALLET_HOLD_SWEEP_MS }, undefined);
  await jobs.schedule('outbox.relay', { everyMs: OUTBOX_RELAY_MS }, undefined);
  await jobs.schedule(
    'notifications.sweep-deliveries',
    { everyMs: NOTIFICATION_DELIVERY_SWEEP_MS },
    undefined,
  );
  // §10：目录刷新每 6 小时 + 抖动（抖动在服务内部按 isDue 施加）。目录源被显式
  // 关闭（`off`）的实例不注册处理器也不排期，保持零出网。
  if (deps.catalogRefresh) {
    jobs.handle(KERNEL_JOBS.catalogRefresh, async () => {
      await deps.catalogRefresh?.();
    });
    await jobs.schedule(
      KERNEL_JOBS.catalogRefresh,
      { everyMs: CATALOG_REFRESH_MS },
      undefined,
    );
  }
  // §13-6：目录刷新后评估自动更新。与刷新同频（刷新内部按 isDue 施加抖动与离线短路）；
  // 目录源关闭时 deps.autoUpdate 为 undefined，不注册、零出网。
  if (deps.catalogRefresh && deps.autoUpdate) {
    jobs.handle(KERNEL_JOBS.autoUpdate, async () => {
      await deps.autoUpdate?.();
    });
    await jobs.schedule(KERNEL_JOBS.autoUpdate, { everyMs: CATALOG_REFRESH_MS }, undefined);
  }
  // 会员权益到期清理：删除已过期的限时成员关系。授权正确性由读路径保证
  // （过期成员不授予任何权限），这里只做数据清理，晚跑一小时也不会放行过期会员。
  if (deps.membershipSweep) {
    jobs.handle(KERNEL_JOBS.membershipSweep, async () => {
      await deps.membershipSweep?.();
    });
    await jobs.schedule(
      KERNEL_JOBS.membershipSweep,
      { everyMs: MEMBERSHIP_SWEEP_MS },
      undefined,
    );
  }
}

/** One dead-lettered job (failed past its attempt budget). */
export interface DeadLetterJob {
  id: string;
  name: string;
  payload: unknown;
  attemptsMade: number;
  failedReason: string;
  failedAt: string | null;
}

/**
 * List dead-lettered jobs for the admin observability endpoint. Requires a
 * BullMQ backend; the in-process fallback keeps no cross-process dead letters.
 */
export async function listDeadLetterJobs(
  redisUrl: string | null,
  limit = 50,
): Promise<DeadLetterJob[]> {
  if (!redisUrl) return [];
  const queue = new Queue(KERNEL_QUEUE_NAME, {
    connection: redisConnectionOptions(redisUrl),
    prefix: REDIS_KEY_PREFIX.bull,
  });
  try {
    const failed = await queue.getFailed(0, Math.max(0, limit - 1));
    return failed.map((job) => ({
      id: job.id ?? '',
      name: job.name,
      payload: (job.data as { payload?: unknown })?.payload ?? null,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason,
      failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    }));
  } finally {
    await queue.close().catch(() => undefined);
  }
}

/** Re-enqueue a dead-lettered job by id. Returns the new job id. */
export async function retryDeadLetterJob(
  redisUrl: string | null,
  jobId: string,
): Promise<string | null> {
  if (!redisUrl) return null;
  const queue = new Queue(KERNEL_QUEUE_NAME, {
    connection: redisConnectionOptions(redisUrl),
    prefix: REDIS_KEY_PREFIX.bull,
  });
  try {
    const job = await queue.getJob(jobId);
    if (!job) return null;
    await job.retry();
    return job.id ?? null;
  } finally {
    await queue.close().catch(() => undefined);
  }
}

/** Queue states surfaced as metrics (matches BullMQ's job types). */
const METRIC_JOB_STATES = ['waiting', 'active', 'delayed', 'failed', 'completed'] as const;

/**
 * Read the shared queue depth per state for the metrics collector. Returns null
 * without Redis (the in-process backend has no cross-process queue).
 */
export async function jobQueueCounts(redisUrl: string | null): Promise<Record<string, number> | null> {
  if (!redisUrl) return null;
  const queue = new Queue(KERNEL_QUEUE_NAME, {
    connection: redisConnectionOptions(redisUrl),
    prefix: REDIS_KEY_PREFIX.bull,
  });
  try {
    const counts = await queue.getJobCounts(...METRIC_JOB_STATES);
    return counts;
  } catch {
    return null;
  } finally {
    await queue.close().catch(() => undefined);
  }
}
