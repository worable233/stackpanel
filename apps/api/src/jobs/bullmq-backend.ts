/**
 * BullMQ-backed job storage (ADR-0013). Redis is the queue; this backend only
 * maps the kernel's handler/schedule registry onto BullMQ primitives.
 *
 * Cluster semantics come for free: BullMQ guarantees a job is fetched by a
 * single worker, and `upsertJobScheduler` keeps exactly one recurring scheduler
 * per id across every replica.
 *
 * The queue key prefix is `REDIS_KEY_PREFIX.bull` (`bull:`), so all queue state
 * is namespaced and inspectable independently of the rest of Redis.
 */
import { Queue, Worker } from 'bullmq';
import { REDIS_KEY_PREFIX } from '@stackpanel/sdk';
import type { JobHandler, JobOptions } from '@stackpanel/sdk';
import { redisConnectionOptions } from './redis-connection.ts';
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  DEFAULT_CONCURRENCY,
  type JobBackend,
  type RegisteredSchedule,
} from './types.ts';

export const KERNEL_QUEUE_NAME = 'stackpanel';

interface BullJobData {
  /** Fully-qualified `<owner>.<name>` job name. */
  fullName: string;
  payload: unknown;
}

export interface BullMqBackendOptions {
  redisUrl: string;
  logger: { info: (m: string) => void; warn: (m: string) => void };
  concurrency?: number;
  /** Optional kernel-owned handler: never throw for an unknown job name. */
  onUnknownJob?: (fullName: string) => void;
}

/** A job whose failure should not be retried (bad payload / unknown handler). */
class PermanentJobError extends Error {}

function attemptsOf(options?: JobOptions): number {
  return Math.max(1, options?.attempts ?? DEFAULT_ATTEMPTS);
}

export class BullMqJobBackend implements JobBackend {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules = new Map<string, RegisteredSchedule>();
  private queue: Queue<BullJobData> | null = null;
  private worker: Worker<BullJobData> | null = null;
  private started = false;

  constructor(private readonly options: BullMqBackendOptions) {}

  private connection(): { connection: ReturnType<typeof redisConnectionOptions> } {
    return { connection: redisConnectionOptions(this.options.redisUrl) };
  }

  private getQueue(): Queue<BullJobData> {
    if (!this.queue) {
      this.queue = new Queue<BullJobData>(KERNEL_QUEUE_NAME, {
        ...this.connection(),
        prefix: REDIS_KEY_PREFIX.bull,
      });
    }
    return this.queue;
  }

  handle(fullName: string, handler: JobHandler): void {
    this.handlers.set(fullName, handler);
  }

  unhandle(fullName: string): void {
    this.handlers.delete(fullName);
  }

  async schedule(entry: RegisteredSchedule): Promise<void> {
    this.schedules.set(entry.fullName, entry);
    if (!this.started) return;
    await this.upsert(entry);
  }

  async unschedule(fullName: string): Promise<void> {
    this.schedules.delete(fullName);
    if (!this.started) return;
    await this.getQueue()
      .removeJobScheduler(fullName)
      .catch((err: unknown) => {
        this.options.logger.warn(`[jobs] removeJobScheduler ${fullName} failed: ${String(err)}`);
        return false;
      });
  }

  async enqueue(fullName: string, payload: unknown, options?: JobOptions): Promise<string> {
    const attempts = attemptsOf(options);
    const job = await this.getQueue().add(
      fullName,
      { fullName, payload },
      {
        attempts,
        backoff: { type: 'fixed', delay: options?.backoffMs ?? DEFAULT_BACKOFF_MS },
        ...(options?.delayMs !== undefined ? { delay: options.delayMs } : {}),
        // A custom job id provides dedup: BullMQ ignores an add whose waiting /
        // delayed job already holds the id.
        ...(options?.jobId ? { jobId: options.jobId } : {}),
        // Completed jobs are pruned; failures are retained as the dead-letter set.
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { count: 5000 },
      },
    );
    return job.id ?? '';
  }

  async removeByOwner(prefix: string): Promise<void> {
    // Handler registration is per-process; schedules are in Redis and shared.
    for (const name of [...this.handlers.keys()]) {
      if (name === prefix || name.startsWith(`${prefix}.`)) this.handlers.delete(name);
    }
    for (const [fullName] of [...this.schedules]) {
      if (fullName === prefix || fullName.startsWith(`${prefix}.`)) {
        await this.unschedule(fullName);
      }
    }
    if (!this.started || !this.queue) return;
    const matches = (name: string): boolean => name === prefix || name.startsWith(`${prefix}.`);
    // A deactivated plugin must not leave already queued work to be retried by
    // every replica. Active jobs are allowed to finish; waiting/delayed jobs are
    // removed best-effort because BullMQ owns their Redis state.
    const queued = await this.queue.getJobs(['waiting', 'delayed', 'prioritized', 'waiting-children'], 0, -1);
    await Promise.all(queued
      .filter((job) => matches(job.data.fullName))
      .map((job) => job.remove().catch((err: unknown) => {
        this.options.logger.warn(`[jobs] remove queued job ${job.id ?? '?'} failed: ${String(err)}`);
      })));
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.getQueue().waitUntilReady();
    // Re-declare every known schedule; upsert is idempotent, so a replica that
    // restarts or a schedule that was lost is restored.
    for (const entry of this.schedules.values()) {
      await this.upsert(entry);
    }
    await this.startWorker();
    this.options.logger.info('[jobs] BullMQ backend started');
  }

  private async upsert(entry: RegisteredSchedule): Promise<void> {
    const repeatOpts =
      'everyMs' in entry.schedule
        ? { every: entry.schedule.everyMs }
        : { pattern: entry.schedule.cron };
    await this.getQueue().upsertJobScheduler(entry.fullName, repeatOpts, {
      name: entry.fullName,
      data: { fullName: entry.fullName, payload: entry.payload },
      opts: {
        attempts: attemptsOf(entry.options),
        backoff: { type: 'fixed', delay: entry.options?.backoffMs ?? DEFAULT_BACKOFF_MS },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }

  private async startWorker(): Promise<void> {
    this.worker = new Worker<BullJobData>(
      KERNEL_QUEUE_NAME,
      async (job) => {
        const { fullName, payload } = job.data;
        const handler = this.handlers.get(fullName);
        if (!handler) {
          // The handler is absent on this replica (e.g. the owning plugin is not
          // active here). Fail immediately rather than burning the retry budget.
          this.options.onUnknownJob?.(fullName);
          throw new PermanentJobError(`未知任务处理器：${fullName}`);
        }
        await handler(payload);
      },
      {
        ...this.connection(),
        prefix: REDIS_KEY_PREFIX.bull,
        concurrency: this.options.concurrency ?? DEFAULT_CONCURRENCY,
      },
    );
    this.worker.on('failed', (job, err) => {
      const attempts = job?.opts.attempts ?? 1;
      const made = job?.attemptsMade ?? 0;
      if (made >= attempts) {
        this.options.logger.warn(
          `[jobs] job ${job?.name ?? '?'} entered dead letter after ${made} attempt(s): ${err.message}`,
        );
      }
    });
    this.worker.on('error', (err) => {
      this.options.logger.warn(`[jobs] worker error: ${String(err)}`);
    });
    await this.worker.waitUntilReady();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.worker?.close().catch(() => undefined);
    this.worker = null;
    await this.queue?.close().catch(() => undefined);
    this.queue = null;
  }
}
