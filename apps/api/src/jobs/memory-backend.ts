/**
 * In-process job backend for development and tests without Redis (ADR-0013
 * fallback). It preserves the *contract* — namespaced handlers, recurring jobs,
 * bounded retries — but not the cluster guarantee: timers run in whichever
 * process created them. Production requires Redis, so this is never the
 * multi-replica path.
 */
import { randomUUID } from 'node:crypto';
import type { JobHandler, JobOptions } from '@stackpanel/sdk';
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  type JobBackend,
  type RegisteredSchedule,
} from './types.ts';

export interface MemoryJobBackendOptions {
  logger: { warn: (m: string) => void };
}

export class MemoryJobBackend implements JobBackend {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules = new Map<
    string,
    { timer: ReturnType<typeof setInterval>; entry: RegisteredSchedule }
  >();
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
    if (!('everyMs' in entry.schedule)) {
      this.options.logger.warn(
        `[jobs] cron 调度需要 Redis；开发回退忽略 ${entry.fullName} 的 cron 声明`,
      );
      return;
    }
    await this.unschedule(entry.fullName);
    const timer = setInterval(() => {
      void this.run(entry.fullName, entry.payload, entry.options);
    }, entry.schedule.everyMs);
    timer.unref?.();
    this.schedules.set(entry.fullName, { timer, entry });
  }

  async unschedule(fullName: string): Promise<void> {
    const existing = this.schedules.get(fullName);
    if (existing) {
      clearInterval(existing.timer);
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
  }
}
