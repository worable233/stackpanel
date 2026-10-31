/**
 * In-process {@link StateService}. Single-node only; the interface is designed
 * so a Redis-backed implementation can replace it without touching plugins
 * (see `packages/sdk/src/state.ts`). Lazy expiry on access plus a periodic sweep
 * keeps memory bounded.
 */
import type { StateCandidate, StateLease, StateService } from '@stackpanel/sdk';
import { randomUUID } from 'node:crypto';

interface Entry {
  value: string;
  /** Absolute expiry in epoch ms, or null for no expiry. */
  expiresAt: number | null;
}

export class MemoryStateService implements StateService {
  private readonly entries = new Map<string, Entry>();
  /** Seat pools, keyed exactly as the counter keys the caller chose. */
  private readonly leases = new Map<string, Map<string, number>>();

  private live(key: string): Entry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async consume(key: string): Promise<string | null> {
    const value = this.live(key)?.value ?? null;
    this.entries.delete(key);
    return value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: ttlMs && ttlMs > 0 ? Date.now() + ttlMs : null,
    });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async incr(key: string, ttlMs?: number): Promise<number> {
    const current = this.live(key);
    const next = (current ? Number(current.value) : 0) + 1;
    this.entries.set(key, {
      value: String(next),
      // Keep the existing expiry; only a fresh counter takes the new TTL.
      expiresAt: current ? current.expiresAt : ttlMs && ttlMs > 0 ? Date.now() + ttlMs : null,
    });
    return next;
  }

  async ttl(key: string): Promise<number | null> {
    const entry = this.live(key);
    if (!entry) return 0;
    if (entry.expiresAt === null) return null;
    return Math.max(0, entry.expiresAt - Date.now());
  }

  async decr(key: string): Promise<number> {
    const current = this.live(key);
    const next = Math.max(0, (current ? Number(current.value) : 0) - 1);
    this.entries.set(key, {
      value: String(next),
      expiresAt: current ? current.expiresAt : null,
    });
    return next;
  }

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    if (this.live(key)) return null;
    const token = randomUUID();
    this.entries.set(key, {
      value: token,
      expiresAt: ttlMs && ttlMs > 0 ? Date.now() + ttlMs : null,
    });
    return token;
  }

  async release(key: string, token: string): Promise<boolean> {
    const entry = this.live(key);
    if (!entry || entry.value !== token) return false;
    this.entries.delete(key);
    return true;
  }

  async withLock(key: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean> {
    const token = await this.acquire(key, ttlMs);
    if (!token) return false;
    try {
      await fn();
      return true;
    } finally {
      await this.release(key, token);
    }
  }

  /**
   * Try each candidate in order, taking the first free seat. Single-node, so
   * the whole loop is atomic: there is no `await` between the read and the
   * write. Seats are tracked per token so a stale holder cannot free a seat
   * that was already reclaimed.
   */
  async acquireLease(
    candidates: ReadonlyArray<StateCandidate>,
    ttlMs?: number,
  ): Promise<StateLease | null> {
    const expiresAt = ttlMs && ttlMs > 0 ? Date.now() + ttlMs : Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const holders = this.liveHolders(candidate.key) ?? new Map<string, number>();
      if (candidate.limit <= 0 || holders.size < candidate.limit) {
        const token = randomUUID();
        holders.set(token, expiresAt);
        this.leases.set(candidate.key, holders);
        return { key: candidate.key, token };
      }
    }
    return null;
  }

  async renewLease(lease: StateLease, ttlMs?: number): Promise<boolean> {
    const holders = this.liveHolders(lease.key);
    if (!holders?.has(lease.token)) return false;
    holders.set(
      lease.token,
      ttlMs && ttlMs > 0 ? Date.now() + ttlMs : Number.POSITIVE_INFINITY,
    );
    return true;
  }

  async releaseLease(lease: StateLease): Promise<boolean> {
    const holders = this.liveHolders(lease.key);
    const released = holders?.delete(lease.token) ?? false;
    if (holders && holders.size === 0) this.leases.delete(lease.key);
    return released;
  }

  /**
   * Holders for `key` with expired tokens pruned, or `null` when the key has no
   * pool. Read-only: callers that add a holder write the map back themselves.
   */
  private liveHolders(key: string): Map<string, number> | null {
    const holders = this.leases.get(key);
    if (!holders) return null;
    const now = Date.now();
    for (const [token, expiresAt] of holders) {
      if (expiresAt <= now) holders.delete(token);
    }
    return holders;
  }

  /** Drop expired entries; called periodically by the kernel. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
    for (const [key, holders] of this.leases) {
      for (const [token, expiresAt] of holders) {
        if (expiresAt <= now) holders.delete(token);
      }
      if (holders.size === 0) this.leases.delete(key);
    }
  }
}
