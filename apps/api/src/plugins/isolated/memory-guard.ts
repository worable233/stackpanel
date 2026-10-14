/**
 * Isolated-worker memory guard (security audit C-2).
 *
 * A plugin worker runs in its own child process, so its V8 heap is bounded by
 * `--max-old-space-size` (see `host.ts`). That bound covers *heap* only: large
 * `Buffer`s, typed arrays and native allocations live off-heap, so a hostile or
 * buggy plugin can still grow its resident set without ever tripping the heap
 * limit — enough to pressure the container and starve the API process that
 * spawned it.
 *
 * This guard samples the worker's peak resident set (`resourceUsage().maxRSS`)
 * and terminates the worker once it crosses a configured ceiling. The host then
 * observes the exit and applies its normal quarantine/circuit-breaker path. The
 * container `mem_limit` remains the hard backstop; this is the in-process early
 * trip that keeps one plugin from degrading its siblings first.
 */
import { resourceUsage } from 'node:process';

/**
 * Default RSS ceiling in MiB for a plugin worker. Chosen above the default
 * `--max-old-space-size` (256 MiB) so a legitimate worker can use its full heap
 * plus runtime overhead, while staying well under the 768 MiB container limit.
 */
export const DEFAULT_PLUGIN_MAX_RSS_MB = 512;

/** Sampling interval for the guard. */
export const MEMORY_GUARD_INTERVAL_MS = 2_000;

/**
 * Parse the configured RSS ceiling. A missing, non-finite or non-positive value
 * falls back to {@link DEFAULT_PLUGIN_MAX_RSS_MB}. A value of `0` therefore does
 * not disable the guard — pass a negative value through {@link startMemoryGuard}
 * to explicitly disable it.
 */
export function resolveMaxRssMb(raw: string | number | undefined): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_PLUGIN_MAX_RSS_MB;
}

/** Convert a `resourceUsage()` reading (maxRSS is in KiB) to MiB. */
export function maxRssMb(usage: { maxRSS: number }): number {
  return usage.maxRSS / 1024;
}

export interface MemoryGuardOptions {
  /** Ceiling in MiB. Values `<= 0` disable the guard. */
  maxRssMb: number;
  /** Sampling interval; defaults to {@link MEMORY_GUARD_INTERVAL_MS}. */
  intervalMs?: number;
  /** Peak-RSS reader in MiB; defaults to `process.resourceUsage().maxRSS / 1024`. */
  readMaxRssMb?: () => number;
  /** Invoked once when the ceiling is crossed, then the guard stops itself. */
  onExceed: (rssMb: number) => void;
  /** Timer injection point for deterministic tests. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface MemoryGuardHandle {
  /** Stop sampling. Safe to call more than once. */
  stop(): void;
}

/**
 * Start sampling peak RSS and invoke `onExceed` the first time the ceiling is
 * crossed. The returned handle stops sampling; the timer is `unref`'d so it
 * never keeps the worker alive on its own.
 */
export function startMemoryGuard(options: MemoryGuardOptions): MemoryGuardHandle {
  if (!Number.isFinite(options.maxRssMb) || options.maxRssMb <= 0) {
    return { stop: () => undefined };
  }
  const read = options.readMaxRssMb ?? (() => maxRssMb(resourceUsage()));
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let stopped = false;
  const timer = setIntervalFn(() => {
    if (stopped) return;
    const rssMb = read();
    if (rssMb <= options.maxRssMb) return;
    stopped = true;
    clearIntervalFn(timer);
    options.onExceed(rssMb);
  }, options.intervalMs ?? MEMORY_GUARD_INTERVAL_MS);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}
