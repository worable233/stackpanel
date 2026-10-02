/**
 * Background-job primitives for plugins (ADR-0013 §3).
 *
 * A plugin cannot own a timer: in a multi-replica deployment every replica would
 * run it, duplicating work. This is the seam for that. Plugins declare named
 * handlers and (optionally) schedules; the kernel owns the queue, the worker
 * pool, retry/backoff and the dead-letter set, so a task runs exactly once
 * across the cluster (at-least-once delivery + idempotent handlers).
 *
 * Names are namespaced by the kernel as `<pluginId>.<name>`, so two plugins may
 * both declare a `sync` job without colliding. Kernel-owned jobs use the
 * reserved `kernel.` namespace.
 */

/** Retry/backoff policy for a job. Set when it is enqueued or scheduled. */
export interface JobOptions {
  /** Max attempts before the job is kept in the dead-letter set. Default 3. */
  attempts?: number;
  /** Fixed backoff between attempts, in milliseconds. Default 1000. */
  backoffMs?: number;
  /** Delay before the first attempt, in milliseconds. */
  delayMs?: number;
  /**
   * Idempotency key. A job already waiting/delayed with the same id is not
   * enqueued again (the existing job wins). Use it for "coalesce duplicate
   * triggers" cases such as one sync per source.
   */
  jobId?: string;
}

/**
 * Declares a recurring job. Use exactly one member:
 * - `everyMs`: fixed interval (seconds-resolution work such as polling);
 * - `cron`: a 5-field cron expression (minute resolution and above).
 *
 * Cron scheduling requires Redis (the in-process development fallback only
 * supports `everyMs`).
 */
export type JobSchedule = { everyMs: number } | { cron: string };

/** A job handler runs on the worker pool; it must be idempotent. */
export type JobHandler<T = unknown> = (payload: T) => Promise<void> | void;

/**
 * Plugin-facing background task contract. The kernel namespaces every name by
 * the owning plugin and tears down a plugin's handlers/schedules when it is
 * deactivated, so an inactive plugin leaves no live jobs behind.
 */
export interface JobContext {
  /** Enqueue a retryable job. Returns the job id. */
  enqueue<T>(name: string, payload: T, opts?: JobOptions): Promise<string>;
  /**
   * Declare a recurring job. Idempotent for the same `name` (re-declaring
   * replaces the schedule). Torn down automatically on plugin deactivation.
   */
  schedule(name: string, schedule: JobSchedule, payload?: unknown): Promise<void>;
  /**
   * Register the handler for `name`. Called during activation; registering the
   * same name again replaces the previous handler. Returned disposer removes it
   * (cleanup also happens automatically on deactivation).
   */
  handle<T>(name: string, handler: JobHandler<T>): () => void;
}
