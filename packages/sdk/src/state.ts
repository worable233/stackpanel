/**
 * Shared-state primitives for plugins.
 *
 * A gateway needs cross-request coordination that a single plugin instance
 * cannot express with plain in-memory variables once it runs in more than one
 * process: concurrency caps, rate windows, key→account stickiness, and
 * scheduling locks. This is the pluggable seam for that. The kernel ships an
 * in-process implementation; a Redis-backed implementation can be dropped in
 * without changing this contract.
 *
 * All values are strings (counters use `incr`/`decr`). TTLs are in
 * milliseconds; `undefined` means no expiry (counters set it on first `incr`).
 */
export interface StateService {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Increment a counter, setting `ttlMs` on the first increment. Returns the new value. */
  incr(key: string, ttlMs?: number): Promise<number>;
  /** Decrement a counter (floored at 0). */
  decr(key: string): Promise<number>;
  /** Acquire a lock keyed by `key`. Returns false if already held. */
  acquire(key: string, ttlMs: number): Promise<boolean>;
  /** Release a previously acquired lock. */
  release(key: string): Promise<void>;
  /**
   * Run `fn` while holding the lock. Returns true if the lock was acquired and
   * `fn` ran; false if it was busy (fn is skipped).
   */
  withLock(key: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean>;
}
