/**
 * In-process {@link StateService}. Single-node only; the interface is designed
 * so a Redis-backed implementation can replace it without touching plugins
 * (see `packages/sdk/src/state.ts`). Lazy expiry on access plus a periodic sweep
 * keeps memory bounded.
 */
import type { StateService } from '@stackpanel/sdk';
import { randomUUID } from 'node:crypto';

interface Entry {
  value: string;
  /** Absolute expiry in epoch ms, or null for no expiry. */
  expiresAt: number | null;
}

export class MemoryStateService implements StateService {
  private readonly entries = new Map<string, Entry>();

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

  /** Drop expired entries; called periodically by the kernel. */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
