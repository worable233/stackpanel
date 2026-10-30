/**
 * In-process job backend for development and tests without Redis (ADR-0013
 * fallback). It preserves the *contract* — namespaced handlers, recurring jobs
 * (including `cron`), bounded retries — and, when a {@link JobLease} is supplied,
 * the cluster guarantee too: every replica fires its own timer, but only the
 * replica that wins the lease actually runs the tick (对标 #12.5).
 *
 * Without a lease (`guard` omitted) timers run in whichever process created
 * them — fine for tests and single-replica development, not for a cluster.
 *
 * `cron` runs here as well as `everyMs`: dropping it would make scheduled work
 * fail silently on a single-node deployment without Redis. Redis governs *how
 * many replicas* run a tick, never *whether* it can run at all (audit E-10).
 */
import { randomUUID } from 'node:crypto';
import type { JobHandler, JobOptions } from '@stackpanel/sdk';
import { leaseTtlMs, type JobLease } from './lease.ts';
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  type JobBackend,
  type RegisteredSchedule,
} from './types.ts';
import { nextCronFireMs } from './cron.ts';

export interface MemoryJobBackendOptions {
  logger: { warn: (m: string) => void };
  /**
   * 跨副本租约。给了就「一个 tick 只有一个副本执行」；不给则各副本各跑一份
   * （测试与单副本开发用，集群下会重复执行）。
   */
  guard?: JobLease;
}

export class MemoryJobBackend implements JobBackend {
  readonly kind = 'memory' as const;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules = new Map<
    string,
    { stop: () => void; entry: RegisteredSchedule }
  >();
  /** Names whose previous run has not finished; a timer tick never stacks up. */
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<ReturnType<typeof setTimeout>, { fullName: string; jobId?: string }>();
  private readonly queuedIds = new Map<string, string>();

  constructor(private readonly options: MemoryJobBackendOptions) {}

  handle(fullName: string, handler: JobHandler): void {
    this.handlers.set(fullName, handler);
  }

  unhandle(fullName: string): void {
    this.handlers.delete(fullName);
  }

  async schedule(entry: RegisteredSchedule): Promise<void> {
    await this.unschedule(entry.fullName);
    if ('everyMs' in entry.schedule) {
      const timer = setInterval(() => {
        // Through `tick`, not `run`: the lease is what stops every replica from
        // executing the same tick, and it must apply to `everyMs` too.
        void this.tick(entry);
      }, entry.schedule.everyMs);
      timer.unref?.();
      this.schedules.set(entry.fullName, { stop: () => clearInterval(timer), entry });
      return;
    }

    // cron：进程内按「下一次触发时刻」重新武装定时器。丢掉 cron 会让排期工作
    // 在无 Redis 的单节点部署里静默失效（audit E-10）——Redis 只负责多副本协调，
    // 不是「能不能跑」的前提。表达式非法时只警告一次并停止，绝不自作主张猜。
    const cron = entry.schedule.cron;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const arm = (): void => {
      if (stopped) return;
      let delayMs: number;
      try {
        delayMs = Math.max(0, nextCronFireMs(cron, Date.now()) - Date.now());
      } catch (error) {
        stopped = true;
        this.options.logger.warn(
          `[jobs] ${entry.fullName} 的 cron 表达式不可用（${String(error)}），已停止调度`,
        );
        return;
      }
      timer = setTimeout(() => {
        if (stopped) return;
        arm();
        // Same reason as `everyMs`: cron ticks contend for the lease too.
        void this.tick(entry);
      }, delayMs);
      timer.unref?.();
    };
    arm();
    this.schedules.set(entry.fullName, {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
      entry,
    });
  }

  async unschedule(fullName: string): Promise<void> {
    const existing = this.schedules.get(fullName);
    if (existing) {
      existing.stop();
      this.schedules.delete(fullName);
    }
  }

  async enqueue(fullName: string, payload: unknown, options?: JobOptions): Promise<string> {
    const id = options?.jobId ?? randomUUID();
    if (options?.jobId && this.queuedIds.has(options.jobId)) return id;
    if (options?.jobId) this.queuedIds.set(options.jobId, fullName);
    const delay = options?.delayMs ?? 0;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (options?.jobId && this.queuedIds.get(options.jobId) === fullName) this.queuedIds.delete(options.jobId);
      void this.run(fullName, payload, options);
    }, delay);
    timer.unref?.();
    this.timers.set(timer, { fullName, ...(options?.jobId ? { jobId: options.jobId } : {}) });
    return id;
  }

  async removeByOwner(prefix: string): Promise<void> {
    const matches = (name: string): boolean => name === prefix || name.startsWith(`${prefix}.`);
    for (const name of [...this.handlers.keys()]) {
      if (matches(name)) this.handlers.delete(name);
    }
    for (const [fullName] of [...this.schedules]) {
      if (matches(fullName)) await this.unschedule(fullName);
    }
    for (const [timer, queued] of this.timers) {
      if (matches(queued.fullName)) {
        clearTimeout(timer);
        this.timers.delete(timer);
        if (queued.jobId && this.queuedIds.get(queued.jobId) === queued.fullName) this.queuedIds.delete(queued.jobId);
      }
    }
  }

  async start(): Promise<void> {
    // No-op: the in-process backend runs timers as soon as they are registered.
  }

  async stop(): Promise<void> {
    for (const name of [...this.schedules.keys()]) await this.unschedule(name);
    for (const timer of this.timers.keys()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * 一个定时器 tick：先抢租约，抢到才执行。
   *
   * 租约出错按「没抢到」处理 —— 宁可这一轮不跑（下一轮会补），也不能因为
   * 数据库抖一下就变成多副本重复执行。
   */
  private async tick(entry: RegisteredSchedule): Promise<void> {
    const guard = this.options.guard;
    if (guard) {
      let acquired: boolean;
      try {
        const everyMs = 'everyMs' in entry.schedule ? entry.schedule.everyMs : 60_000;
        acquired = await guard.tryAcquire(entry.fullName, leaseTtlMs(everyMs));
      } catch (error) {
        this.options.logger.warn(
          `[jobs] 租约获取失败，跳过本轮 ${entry.fullName}：${String(error)}`,
        );
        return;
      }
      if (!acquired) return;
    }
    await this.run(entry.fullName, entry.payload, entry.options);
  }

  /** Attempt `fullName` with bounded retries. Never throws to the timer. */
  private async run(
    fullName: string,
    payload: unknown,
    options?: { attempts?: number; backoffMs?: number },
  ): Promise<void> {
    const handler = this.handlers.get(fullName);
    if (!handler) {
      this.options.logger.warn(`[jobs] 忽略未知任务：${fullName}`);
      return;
    }
    // A slow sweep must not stack up: without a queue, skipping the tick is the
    // only sane behaviour (the handler is idempotent and runs again next tick).
    if (this.inFlight.has(fullName)) return;
    this.inFlight.add(fullName);
    try {
      const attempts = Math.max(1, options?.attempts ?? DEFAULT_ATTEMPTS);
      const backoff = options?.backoffMs ?? DEFAULT_BACKOFF_MS;
      for (let made = 1; made <= attempts; made += 1) {
        try {
          await handler(payload);
          return;
        } catch (err) {
          if (made >= attempts) {
            this.options.logger.warn(
              `[jobs] 任务 ${fullName} 在 ${made} 次尝试后进入死信：${String(err)}`,
            );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    } finally {
      this.inFlight.delete(fullName);
    }
  }
}
