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
  } else {
    options.logger.warn('[jobs] 未配置 Redis，任务使用进程内实现（仅单机正确）');
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
  logger: { warn: (m: string) => void };
}

/** Fixed intervals for kernel sweeps. */
const STATE_SWEEP_MS = 60_000;
const PAYMENT_SWEEP_MS = 5 * 60_000;
const OUTBOX_RELAY_MS = 2_000;
/** Run outbox retention roughly hourly (every N relay passes). */
const OUTBOX_CLEANUP_EVERY = Math.max(1, Math.round((60 * 60_000) / OUTBOX_RELAY_MS));

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
  await jobs.schedule('outbox.relay', { everyMs: OUTBOX_RELAY_MS }, undefined);
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
