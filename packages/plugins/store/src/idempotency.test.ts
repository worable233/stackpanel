import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, PluginContext, StateService } from '@stackpanel/sdk';
import { bindContext, resetContext } from './context';
import { withIdempotency } from './idempotency';

/** Minimal in-memory StateService mirroring the kernel contract. */
function memoryState(): StateService {
  const values = new Map<string, { value: string; expiresAt: number | null }>();
  const locks = new Map<string, string>();
  const alive = (key: string): boolean => {
    const entry = values.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      values.delete(key);
      return false;
    }
    return true;
  };
  return {
    async get(key) {
      return alive(key) ? (values.get(key)!.value as string) : null;
    },
    async consume(key) {
      const value = alive(key) ? values.get(key)!.value : null;
      values.delete(key);
      return value;
    },
    async set(key, value, ttlMs) {
      values.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
    },
    async del(key) {
      values.delete(key);
    },
    async incr(key, ttlMs) {
      const next = Number(alive(key) ? values.get(key)!.value : 0) + 1;
      values.set(key, { value: String(next), expiresAt: ttlMs ? Date.now() + ttlMs : null });
      return next;
    },
    async decr(key) {
      const next = Math.max(0, Number(alive(key) ? values.get(key)!.value : 0) - 1);
      values.set(key, { value: String(next), expiresAt: null });
      return next;
    },
    async acquire(key, ttlMs) {
      if (locks.has(key)) return null;
      const token = `lock-${Math.random()}`;
      locks.set(key, token);
      // TTL is not exercised in these tests.
      void ttlMs;
      return token;
    },
    async release(key, token) {
      if (locks.get(key) !== token) return false;
      locks.delete(key);
      return true;
    },
    async withLock(key, ttlMs, fn) {
      const token = await this.acquire(key, ttlMs);
      if (!token) return false;
      try {
        await fn();
        return true;
      } finally {
        await this.release(key, token);
      }
    },
    async acquireLease() {
      return null;
    },
    async renewLease() {
      return false;
    },
    async releaseLease() {
      return false;
    },
  } as StateService;
}

function makeCtx(state: StateService): PluginContext {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    state,
  } as unknown as PluginContext;
}

function request(body: unknown, key?: string): HttpRequest {
  return {
    params: {},
    query: {},
    body,
    headers: key ? { 'idempotency-key': key } : {},
    user: { id: 'user-1', role: 'USER' },
  };
}

describe('withIdempotency', () => {
  beforeEach(() => {
    bindContext(makeCtx(memoryState()));
    return () => resetContext();
  });

  it('runs the handler once and replays the memoised result', async () => {
    const handler = vi.fn(async () => ({ order: { id: 'o1' } }));
    const first = await withIdempotency(request({ productId: 'p1' }, 'key-123456'), 'order.create', handler);
    const second = await withIdempotency(request({ productId: 'p1' }, 'key-123456'), 'order.create', handler);
    expect(first).toEqual({ order: { id: 'o1' } });
    expect(second).toEqual(first);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects the same key reused with a different body', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    await withIdempotency(request({ productId: 'p1' }, 'key-abcdef'), 'order.create', handler);
    await expect(
      withIdempotency(request({ productId: 'p2' }, 'key-abcdef'), 'order.create', handler),
    ).rejects.toMatchObject({ code: 'store.request.idempotency_conflict' });
  });

  it('scopes keys per operation so the same key does not collide across paths', async () => {
    const a = vi.fn(async () => 'order');
    const b = vi.fn(async () => 'renew');
    expect(await withIdempotency(request({}, 'key-shared'), 'order.create', a)).toBe('order');
    expect(await withIdempotency(request({}, 'key-shared'), 'service.renew', b)).toBe('renew');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('runs directly when no idempotency key is present', async () => {
    const handler = vi.fn(async () => 'ran');
    await withIdempotency(request({}), 'order.create', handler);
    await withIdempotency(request({}), 'order.create', handler);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not memoise a failed handler, so a retry re-runs it', async () => {
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      withIdempotency(request({}, 'key-failing'), 'order.create', handler),
    ).rejects.toThrow('boom');
    await expect(
      withIdempotency(request({}, 'key-failing'), 'order.create', handler),
    ).rejects.toThrow('boom');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('rejects a concurrent request holding the same key', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withIdempotency(request({}, 'key-concurrent'), 'order.create', async () => {
      await gate;
      return 'done';
    });
    await expect(
      withIdempotency(request({}, 'key-concurrent'), 'order.create', async () => 'second'),
    ).rejects.toMatchObject({ code: 'store.request.concurrent_request' });
    release();
    expect(await first).toBe('done');
  });
});
