import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedis, getRedis, pingRedis, type RedisClient } from '@stackpanel/db';
import { redisKey } from '@stackpanel/sdk';
import { OutboxEventBus } from '../../src/plugins/events.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';

/**
 * Outbox event bus (S5). Durable delivery + cross-replica fan-out need a real
 * PostgreSQL (always available in the API suite) and a reachable Redis. Redis
 * availability is probed at collection time so the suite skips cleanly when it
 * is absent.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const dbAvailable = await (async (): Promise<boolean> => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();
const redisAvailable = await (async (): Promise<boolean> => {
  try {
    await getRedis(REDIS_URL);
    return await pingRedis();
  } catch {
    return false;
  }
})();

afterAll(async () => {
  await closeRedis();
});

/** Wait until `predicate` returns true, or fail after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!dbAvailable)('OutboxEventBus', () => {
  /** Bind a bus to the real outbox without starting its background relay. */
  const bindLocal = (bus: OutboxEventBus) =>
    bus.configure({ db: getPrisma(), redis: null, production: false });

  it('persists published events and relays them to local subscribers', async () => {
    const bus = new OutboxEventBus();
    bindLocal(bus);
    const seen: unknown[] = [];
    const topic = `test.${randomUUID()}`;
    bus.subscribe(topic, (payload) => seen.push(payload));
    bus.publish(topic, { n: 1 });

    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([{ n: 1 }]);

    // The row exists and is now marked published (not redelivered).
    const row = await getPrisma().outboxEvent.findFirst({
      where: { topic },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    expect(row?.publishedAt).not.toBeNull();

    await bus.relay();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toHaveLength(1);
  });

  it('delivers events without an inline publish (at-least-once after restart)', async () => {
    // Simulate a crash right after the business write: the row exists but the
    // process that would have delivered it is gone. A fresh bus must pick it up.
    const topic = `test.${randomUUID()}`;
    await getPrisma().outboxEvent.create({
      data: { topic, payload: { body: JSON.stringify({ topic, payload: { recovered: true } }) } },
    });

    const bus = new OutboxEventBus();
    bindLocal(bus);
    const seen: unknown[] = [];
    bus.subscribe(topic, (payload) => seen.push(payload));
    await bus.relay();
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([{ recovered: true }]);
  });

  it('does not deliver twice when two replicas relay the same rows', async () => {
    const topic = `test.${randomUUID()}`;
    // Two independent buses (two replicas) over the same outbox.
    const a = new OutboxEventBus();
    const b = new OutboxEventBus();
    bindLocal(a);
    bindLocal(b);
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.subscribe(topic, (payload) => seenA.push(payload));
    b.subscribe(topic, (payload) => seenB.push(payload));

    a.publish(topic, { once: true });
    // Both raced; the row claim lock means only one delivers it locally.
    await Promise.all([a.relay(), b.relay()]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(seenA.length + seenB.length).toBe(1);
  });

  it('fans out across nodes via Redis Pub/Sub', async () => {
    if (!redisAvailable) return; // covered by the dev fallback above
    const redis = await getRedis(REDIS_URL);
    const nodeA = new OutboxEventBus();
    const nodeB = new OutboxEventBus();
    nodeA.configure({ db: getPrisma(), redis, production: false });
    nodeB.configure({ db: getPrisma(), redis, production: false });
    await nodeA.start();
    await nodeB.start();
    try {
      const topic = `test.${randomUUID()}`;
      const seenB: unknown[] = [];
      nodeB.subscribe(topic, (payload) => seenB.push(payload));
      nodeA.publish(topic, { cross: 'node' });
      await waitFor(() => seenB.length === 1, 5000);
      expect(seenB).toEqual([{ cross: 'node' }]);
    } finally {
      await nodeA.stop();
      await nodeB.stop();
    }
  });

  it('namespaces the pub/sub channel under sp:pubsub:', () => {
    expect(redisKey('pubsub', 'events')).toBe('sp:pubsub:events');
  });
});

describe.skipIf(!dbAvailable || !redisAvailable)('OutboxEventBus (redis)', () => {
  it('exposes the redis client used for pub/sub', async () => {
    const redis = (await getRedis(REDIS_URL)) as RedisClient;
    expect(redis.status).toBeDefined();
  });
});
