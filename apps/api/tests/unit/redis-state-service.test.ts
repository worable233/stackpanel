import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedis, getRedis, pingRedis, type RedisClient } from '@stackpanel/db';
import { RedisStateService } from '../../src/state/redis-state-service.ts';

/**
 * Redis state service (S5.5). Uses a real Redis when reachable (local `sp-redis`
 * or CI service); otherwise the suite is skipped so unit runs stay hermetic.
 * Availability is probed at collection time (top-level await) because
 * `describe.skipIf` is evaluated before `beforeAll`.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

const available = await (async (): Promise<boolean> => {
  try {
    await getRedis(REDIS_URL);
    return await pingRedis();
  } catch {
    return false;
  }
})();

const redis = available ? (await getRedis(REDIS_URL)) : null;

afterAll(async () => {
  await closeRedis();
});

/** Unique prefix per run so tests never collide with dev state. */
const prefix = `test:${randomUUID()}:`;

describe.skipIf(!available)('RedisStateService', () => {
  const svc = () => new RedisStateService(redis as RedisClient);

  it('stores, reads and deletes values', async () => {
    const state = svc();
    await state.set(`${prefix}plain`, 'v');
    expect(await state.get(`${prefix}plain`)).toBe('v');
    await state.del(`${prefix}plain`);
    expect(await state.get(`${prefix}plain`)).toBeNull();
  });

  it('expires values after the TTL', async () => {
    const state = svc();
    await state.set(`${prefix}ttl`, 'v', 40);
    expect(await state.get(`${prefix}ttl`)).toBe('v');
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(await state.get(`${prefix}ttl`)).toBeNull();
  });

  it('increments counters and sets TTL only on first incr', async () => {
    const state = svc();
    const key = `${prefix}counter`;
    expect(await state.incr(key, 10_000)).toBe(1);
    expect(await state.incr(key, 10_000)).toBe(2);
    // A second long TTL must not extend the first: remaining TTL stays bounded.
    const pttl = (redis as RedisClient).pttl(`sp:state:${key}`);
    const remaining = await pttl;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(10_000);
  });

  it('decrements counters without going below zero', async () => {
    const state = svc();
    const key = `${prefix}decr`;
    await state.incr(key);
    await state.incr(key);
    expect(await state.decr(key)).toBe(1);
    expect(await state.decr(key)).toBe(0);
    expect(await state.decr(key)).toBe(0);
  });

  it('acquires a lock exclusively and releases it', async () => {
    const state = svc();
    const key = `${prefix}lock`;
    const token = await state.acquire(key, 1000);
    expect(token).toEqual(expect.any(String));
    expect(await state.acquire(key, 1000)).toBeNull();
    expect(await state.release(key, token as string)).toBe(true);
    expect(await state.acquire(key, 1000)).toEqual(expect.any(String));
  });

  it('runs withLock only when the lock is free', async () => {
    const state = svc();
    const key = `${prefix}withlock`;
    let ran = 0;
    expect(await state.withLock(key, 1000, async () => void (ran += 1))).toBe(true);
    expect(ran).toBe(1);
    // Released after the first call, so the second also runs.
    expect(await state.withLock(key, 1000, async () => void (ran += 1))).toBe(true);
    expect(ran).toBe(2);

    await state.acquire(key, 1000);
    expect(await state.withLock(key, 1000, async () => void (ran += 1))).toBe(false);
    expect(ran).toBe(2);
  });

  it('shares state across two client instances (replica simulation)', async () => {
    // Both services point at the same Redis, which is exactly what two API
    // replicas see.
    const a = new RedisStateService(redis as RedisClient);
    const b = new RedisStateService(redis as RedisClient);
    const key = `${prefix}shared`;
    await a.set(key, 'from-a');
    expect(await b.get(key)).toBe('from-a');
    expect(await b.acquire(`${prefix}shared-lock`, 1000)).toEqual(expect.any(String));
    expect(await a.acquire(`${prefix}shared-lock`, 1000)).toBe(false);
  });
});
