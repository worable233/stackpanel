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

/**
 * A seat taken from a capacity-constrained named pool.
 *
 * `token` identifies *this* holder. It must be presented again to
 * {@link StateService.renewLease} and {@link StateService.releaseLease}, so a
 * request that already finished, timed out or was retried can never free a seat
 * that a different request has since taken — which a bare `incr`/`decr` pair
 * cannot express.
 */
export interface StateLease {
  key: string;
  token: string;
}

/** One capacity-constrained pool to try. */
export interface StateCandidate {
  key: string;
  /** Maximum simultaneous holders; `0` or less means unlimited. */
  limit: number;
}

export interface StateService {
  get(key: string): Promise<string | null>;
  /** Read and remove a value atomically when the backend supports it. */
  consume(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Increment a counter, setting `ttlMs` on the first increment. Returns the new value. */
  incr(key: string, ttlMs?: number): Promise<number>;
  /** Decrement a counter (floored at 0). */
  decr(key: string): Promise<number>;
  /**
   * Remaining lifetime of `key`, in milliseconds.
   *
   * Returns `0` when the key is missing or already expired and `null` when it
   * exists without an expiry. Callers use it to tell a rate-limited user **how
   * long** to wait instead of only that they waited too often — a 429 with no
   * `Retry-After` forces every client to guess.
   */
  ttl(key: string): Promise<number | null>;
  /** Acquire a lock keyed by `key`. Returns false if already held. */
  acquire(key: string, ttlMs: number): Promise<string | null>;
  /** Release a lock only when `token` is still its owner. */
  release(key: string, token: string): Promise<boolean>;
  /**
   * Run `fn` while holding the lock. Returns true if the lock was acquired and
   * `fn` ran; false if it was busy (fn is skipped).
   */
  withLock(key: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean>;

  /**
   * Take one seat from the first candidate pool that has one free, in order.
   *
   * Each candidate is `{ key, limit }`, where `limit <= 0` means unlimited. A
   * pool already at its limit is skipped **without** being touched, so a
   * saturated pool is never perturbed; `null` means every candidate is full.
   *
   * This is deliberately atomic per candidate and takes the whole ordered list
   * in a single backend round trip, so a scheduler trying N upstream accounts
   * costs O(1) round trips rather than N `incr`/`decr` pairs. Free the seat with
   * {@link StateService.releaseLease}.
   */
  acquireLease(
    candidates: ReadonlyArray<StateCandidate>,
    ttlMs?: number,
  ): Promise<StateLease | null>;

  /**
   * Extend a held seat's lifetime. Returns `false` when the seat is already
   * gone (expired or released), letting a long-running holder find out instead
   * of silently continuing past its own capacity guarantee.
   */
  renewLease(lease: StateLease, ttlMs?: number): Promise<boolean>;

  /**
   * Release a seat. Only the holder identified by `lease.token` can release it,
   * and releasing a seat that is already gone is a no-op rather than an error.
   */
  releaseLease(lease: StateLease): Promise<boolean>;
}
