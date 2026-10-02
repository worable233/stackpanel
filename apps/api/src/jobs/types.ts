/**
 * Internal job-engine contracts shared by the BullMQ backend, the in-process
 * development fallback, and the kernel/plugin job contexts (ADR-0013).
 *
 * The backend is the storage seam: BullMQ (Redis) in a real deployment, an
 * in-process timer/serial runner in development without Redis. Only the kernel
 * job runtime touches this interface; plugins see the narrow
 * {@link import('@stackpanel/sdk').JobContext}.
 */
import type { JobHandler, JobOptions, JobSchedule } from '@stackpanel/sdk';

/** One worker handler, keyed by its fully-qualified `<owner>.<name>` job name. */
export interface RegisteredHandler {
  fullName: string;
  handler: JobHandler;
}

/** A recurring job declaration, keyed by a stable scheduler id. */
export interface RegisteredSchedule {
  /** Fully-qualified job name (`<owner>.<name>`). */
  fullName: string;
  schedule: JobSchedule;
  payload: unknown;
  options?: JobOptions;
}

/**
 * The kernel-facing job surface. {@link createKernelJobContext} only needs this;
 * the concrete runtime keeps a canonical registry and can swap the storage
 * backend (in-process -> BullMQ) without losing registrations.
 */
export interface JobRuntime {
  handle(fullName: string, handler: JobHandler): void;
  schedule(entry: RegisteredSchedule): Promise<void>;
  enqueue(fullName: string, payload: unknown, options?: JobOptions): Promise<string>;
  removeByOwner(prefix: string): Promise<void>;
}

/** The storage seam behind the kernel job runtime. */
export interface JobBackend {
  /** Register/override the handler for a fully-qualified job name. */
  handle(fullName: string, handler: JobHandler): void;
  /** Register/override a recurring job. Idempotent for the same scheduler id. */
  schedule(entry: RegisteredSchedule): Promise<void>;
  /** Remove a recurring job. */
  unschedule(fullName: string): Promise<void>;
  /** Enqueue one job (the backend prefixes the fully-qualified name). */
  enqueue(fullName: string, payload: unknown, options?: JobOptions): Promise<string>;
  /** Remove every handler + schedule whose name starts with `<prefix>.`. */
  removeByOwner(prefix: string): Promise<void>;
  /** Start consuming. Idempotent. */
  start(): Promise<void>;
  /** Stop consuming and release connections. Idempotent. */
  stop(): Promise<void>;
}

/** How many attempts a job gets before it is kept as a dead letter. */
export const DEFAULT_ATTEMPTS = 3;
/** Fixed backoff between attempts when the caller does not specify one. */
export const DEFAULT_BACKOFF_MS = 1000;
/** Concurrency of the kernel worker pool. */
export const DEFAULT_CONCURRENCY = 4;
