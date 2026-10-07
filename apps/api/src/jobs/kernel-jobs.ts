/**
 * Kernel job runtime (ADR-0013).
 *
 * This is the single place that knows how a job name is namespaced and which
 * backend stores it. `buildApp()` wires {@link getJobRuntime}'s context into the
 * plugin runtime; the worker process builds a runtime over a BullMQ backend.
 * Both share the same backend, so a plugin's `handle()` registration resolves
 * against jobs enqueued by either process.
 *
 * The runtime keeps a canonical registry of handlers and schedules. Because
 * `buildApp()` is synchronous and Redis connects later, the initial backend is
 * in-process; {@link KernelJobRuntime.useBackend} swaps in BullMQ once
 * `initInfra()` connects Redis, replaying the canonical registry so no
 * registration is lost across the swap.
 *
 * Handlers and schedules are owned per `<owner>`; `removeByOwner` tears a
 * plugin's jobs down when it is deactivated, so an inactive plugin leaves
 * nothing live behind.
 */
import type { JobContext, JobHandler, JobOptions, JobSchedule } from '@stackpanel/sdk';
import type { JobBackend, JobRuntime, RegisteredSchedule } from './types.ts';

/** Namespace a job name under its owner: (`store`, `sync`) -> `store.sync`. */
export function qualify(owner: string, name: string): string {
  return `${owner}.${name}`;
}

/** The owner of a fully-qualified name is everything before the first dot. */
export function ownerOf(fullName: string): string {
  const index = fullName.indexOf('.');
  return index === -1 ? fullName : fullName.slice(0, index);
}

/** The local (unqualified) part of a fully-qualified name. */
export function localName(fullName: string): string {
  const index = fullName.indexOf('.');
  return index === -1 ? fullName : fullName.slice(index + 1);
}

/**
 * Canonical in-memory registry that survives a backend swap and delegates to
 * the active {@link JobBackend}.
 */
class CanonicalJobRuntime implements JobRuntime {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schedules = new Map<string, RegisteredSchedule>();
  private backend: JobBackend | null = null;

  constructor(private readonly logger: { warn: (m: string) => void; info: (m: string) => void }) {}

  /** Attach a backend (in-process at boot, BullMQ after Redis connects). */
  async useBackend(backend: JobBackend): Promise<void> {
    this.backend = backend;
    for (const [fullName, handler] of this.handlers) {
      backend.handle(fullName, handler);
    }
    for (const entry of this.schedules.values()) {
      await backend.schedule(entry);
    }
  }

  handle(fullName: string, handler: JobHandler): void {
    this.handlers.set(fullName, handler);
    this.backend?.handle(fullName, handler);
  }

  unhandle(fullName: string): void {
    this.handlers.delete(fullName);
    this.backend?.unhandle(fullName);
  }

  async schedule(entry: RegisteredSchedule): Promise<void> {
    this.schedules.set(entry.fullName, entry);
    await this.backend?.schedule(entry);
  }

  async enqueue(fullName: string, payload: unknown, options?: JobOptions): Promise<string> {
    if (!this.backend) {
      this.logger.warn(`[jobs] 后端未就绪，丢弃入队：${fullName}`);
      return '';
    }
    return this.backend.enqueue(fullName, payload, options);
  }

  async removeByOwner(prefix: string): Promise<void> {
    const matches = (name: string): boolean => name === prefix || name.startsWith(`${prefix}.`);
    for (const name of [...this.handlers.keys()]) {
      if (matches(name)) this.handlers.delete(name);
    }
    for (const name of [...this.schedules.keys()]) {
      if (matches(name)) this.schedules.delete(name);
    }
    await this.backend?.removeByOwner(prefix);
  }

  /** Fully-qualified names of every registered recurring job (diagnostics). */
  listSchedules(): string[] {
    return [...this.schedules.keys()];
  }

  /**
   * Whether a storage backend is attached (i.e. `initInfra()`/`initJobs()` has
   * run). Read-only diagnostics; the media async pipeline uses it to keep the
   * Stage A synchronous path until a queue actually exists.
   */
  hasBackend(): boolean {
    return this.backend !== null;
  }

  start(): Promise<void> {
    return this.backend?.start() ?? Promise.resolve();
  }

  stop(): Promise<void> {
    return this.backend?.stop() ?? Promise.resolve();
  }
}

let runtime: CanonicalJobRuntime | null = null;

/** The process-wide job runtime singleton. */
export function getJobRuntime(): CanonicalJobRuntime {
  if (!runtime) {
    runtime = new CanonicalJobRuntime({
      warn: (message) => console.warn(message),
      info: (message) => console.info(message),
    });
  }
  return runtime;
}

/**
 * Build the {@link JobContext} handed to one plugin (or to the kernel itself,
 * with the reserved owner `kernel`). Every method binds the owner, so a plugin
 * cannot register or enqueue under another plugin's namespace.
 */
export function createKernelJobContext(owner: string, jobs: JobRuntime): JobContext {
  return {
    enqueue: <T>(name: string, payload: T, opts?: JobOptions): Promise<string> =>
      jobs.enqueue(qualify(owner, name), payload, opts),
    schedule: (name: string, schedule: JobSchedule, payload?: unknown): Promise<void> =>
      jobs.schedule({ fullName: qualify(owner, name), schedule, payload }),
    handle: <T>(name: string, handler: JobHandler<T>): (() => void) => {
      const fullName = qualify(owner, name);
      jobs.handle(fullName, handler as JobHandler);
      return () => {
        // Removal is by owner on deactivation; handler overrides are rare.
        jobs.unhandle(fullName);
      };
    },
  };
}

/** Kernel-owned job names reserved for platform sweeps (S6). */
export const KERNEL_JOBS = {
  stateSweep: 'state.sweep',
  paymentSweep: 'payments.sweep-expired',
  outboxRelay: 'outbox.relay',
} as const;
