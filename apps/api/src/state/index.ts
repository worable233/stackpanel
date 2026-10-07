/**
 * Kernel {@link StateService} singleton.
 *
 * `buildApp()` is synchronous and used directly by tests, so it cannot await the
 * Redis connection. The runtime therefore receives a stable router that starts
 * on the in-process implementation and switches to Redis once `initInfra()`
 * connects it (production requires Redis; development without it stays in
 * memory). Plugins read `ctx.state` per activation, so they always observe the
 * current implementation without any consumer change.
 */
import type { RedisClient } from '@stackpanel/db';
import type { StateService } from '@stackpanel/sdk';
import { MemoryStateService } from './state-service.ts';
import { RedisStateService } from './redis-state-service.ts';

class RoutedStateService implements StateService {
  private active: StateService = new MemoryStateService();

  /** Swap the backing implementation (called once, after Redis connects). */
  use(impl: StateService): void {
    this.active = impl;
  }

  get(key: string): Promise<string | null> {
    return this.active.get(key);
  }
  consume(key: string): Promise<string | null> {
    return this.active.consume(key);
  }
  set(key: string, value: string, ttlMs?: number): Promise<void> {
    return this.active.set(key, value, ttlMs);
  }
  del(key: string): Promise<void> {
    return this.active.del(key);
  }
  incr(key: string, ttlMs?: number): Promise<number> {
    return this.active.incr(key, ttlMs);
  }
  decr(key: string): Promise<number> {
    return this.active.decr(key);
  }
  acquire(key: string, ttlMs: number): Promise<string | null> {
    return this.active.acquire(key, ttlMs);
  }
  release(key: string, token: string): Promise<boolean> {
    return this.active.release(key, token);
  }
  withLock(key: string, ttlMs: number, fn: () => Promise<void>): Promise<boolean> {
    return this.active.withLock(key, ttlMs, fn);
  }

  /** In-process only: drop expired keys. Redis expires keys itself. */
  sweep(): void {
    if (this.active instanceof MemoryStateService) {
      this.active.sweep();
    }
  }

  /** Whether the active implementation is Redis-backed (health/diagnostics). */
  get backend(): 'memory' | 'redis' {
    return this.active instanceof RedisStateService ? 'redis' : 'memory';
  }
}

let routed: RoutedStateService | null = null;

/** The process-wide state router. */
export function getStateService(): RoutedStateService {
  if (!routed) routed = new RoutedStateService();
  return routed;
}

/** Bind state to Redis. The kernel calls this from `initInfra()`. */
export function useRedisState(redis: RedisClient): void {
  getStateService().use(new RedisStateService(redis));
}
