import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedis, getRedis, pingRedis, type RedisClient } from '@stackpanel/db';
import { redisKey } from '@stackpanel/sdk';
import { OutboxEventBus, OUTBOX_CLUSTER_CONSUMER, replicaConsumer } from '../../src/plugins/events.ts';
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

  it('T5 backoff + park: persistent publish failure advances attempts and parks', async () => {
    const bus = new OutboxEventBus();
    // Fail every Redis publish so the relay cannot mark the row delivered.
    const failingRedis = {
      publish: async () => {
        throw new Error('redis down');
      },
    } as unknown as RedisClient;
    bus.configure({ db: getPrisma(), redis: failingRedis, production: false, maxAttempts: 3 });
    const topic = `test.${randomUUID()}`;
    const row = await getPrisma().outboxEvent.create({
      data: { topic, payload: { body: JSON.stringify({ topic, payload: { n: 1 } }) } },
    });

    await bus.relay();
    let after = await getPrisma().outboxEvent.findUnique({ where: { id: row.id } });
    expect(after?.attempts).toBe(1);
    expect(after?.lastError).toContain('redis down');
    expect(after?.parkedAt).toBeNull();
    expect(after?.nextAttemptAt).not.toBeNull();

    // Force due and relay until the attempt ceiling parks the row.
    for (let i = 0; i < 3; i += 1) {
      await getPrisma().outboxEvent.update({
        where: { id: row.id },
        data: { nextAttemptAt: new Date(0), lockedAt: null },
      });
      await bus.relay();
    }
    after = await getPrisma().outboxEvent.findUnique({ where: { id: row.id } });
    expect(after?.parkedAt).not.toBeNull();
    expect(after?.publishedAt).toBeNull();

    // Parked rows surface in observability, not silently dropped.
    const stats = await bus.outboxStats();
    expect(stats.parked).toBeGreaterThanOrEqual(1);

    await getPrisma().outboxEvent.delete({ where: { id: row.id } });
  }, 30_000);

  it('T6 idempotency: runIdempotent executes a duplicate eventId only once', async () => {
    const bus = new OutboxEventBus();
    bindLocal(bus);
    const consumer = `test-consumer-${randomUUID()}`;
    const eventId = randomUUID();
    let runs = 0;
    expect(await bus.runIdempotent(consumer, eventId, () => void (runs += 1))).toBe(true);
    expect(await bus.runIdempotent(consumer, eventId, () => void (runs += 1))).toBe(false);
    expect(runs).toBe(1);
    await getPrisma().processedEvent.deleteMany({ where: { consumer } });
  });

  it('T7\' durable consumption: a replica that was offline catches up on its own cursor', async () => {
    const topic = `test.${randomUUID()}`;
    // Replica B is offline while A publishes and relays the row.
    const replicaId = `t7-${randomUUID()}`;
    const consumer = replicaConsumer(replicaId);
    await getPrisma().eventCursor.deleteMany({ where: { consumer } });

    const a = new OutboxEventBus();
    bindLocal(a);
    a.publish(topic, { missed: true });
    // `publish` nudges relay asynchronously; wait for A to have delivered the row.
    const deadline = Date.now() + 4000;
    let row = await getPrisma().outboxEvent.findFirst({
      where: { topic },
      orderBy: { createdAt: 'desc' },
    });
    while (!row?.publishedAt && Date.now() < deadline) {
      await a.relay();
      await new Promise((resolve) => setTimeout(resolve, 25));
      row = await getPrisma().outboxEvent.findFirst({
        where: { topic },
        orderBy: { createdAt: 'desc' },
      });
    }
    expect(row?.publishedAt).not.toBeNull(); // A already delivered it

    // B comes online afterwards with its own subscriber. Relay alone can never
    // deliver this (publishedAt is set); catch-up must.
    const b = new OutboxEventBus();
    b.configure({
      db: getPrisma(),
      redis: null,
      production: false,
      instanceId: replicaId,
      replayWindowMs: 60_000,
    });
    const seen: unknown[] = [];
    const metas: Array<{ eventId?: string }> = [];
    b.subscribe(topic, (payload, meta) => {
      seen.push(payload);
      if (meta?.eventId) metas.push({ eventId: meta.eventId });
    });

    const delivered = await b.catchUp();

    expect(delivered).toBeGreaterThanOrEqual(1);
    expect(seen).toEqual([{ missed: true }]);
    // `eventId` is the outbox row id, so consumers can dedupe on it.
    expect(metas[0]?.eventId).toBe(row?.id);
    // Cursor advanced to that row.
    const cursor = await getPrisma().eventCursor.findUnique({ where: { consumer } });
    expect(cursor?.lastId).toBe(row?.id);

    // A second catch-up must not deliver it again.
    expect(await b.catchUp()).toBe(0);
    expect(seen).toHaveLength(1);

    await getPrisma().eventCursor.deleteMany({ where: { consumer } });
  });

  it('T7b catch-up advances the cursor across batches without skipping rows', async () => {
    const topic = `test.${randomUUID()}`;
    const replicaId = `t7b-${randomUUID()}`;
    const consumer = replicaConsumer(replicaId);
    const order: string[] = [];
    const rows: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const row = await getPrisma().outboxEvent.create({
        data: {
          topic,
          payload: { body: JSON.stringify({ topic, payload: { i } }) },
        },
      });
      rows.push(row.id);
    }

    const bus = new OutboxEventBus();
    bus.configure({
      db: getPrisma(),
      redis: null,
      production: false,
      instanceId: replicaId,
      replayWindowMs: 60_000,
    });
    bus.subscribe(topic, (payload) => order.push(String((payload as { i: number }).i)));

    await bus.catchUp();
    expect(order).toEqual(['0', '1', '2', '3', '4']);

    const cursor = await getPrisma().eventCursor.findUnique({ where: { consumer } });
    expect(cursor?.lastId).toBe(rows[rows.length - 1]);
    // Monotonic: a re-run finds nothing new.
    expect(await bus.catchUp()).toBe(0);

    await getPrisma().eventCursor.deleteMany({ where: { consumer } });
  });

  it('T7c idempotency: live delivery + catch-up on the same row runs the side effect once', async () => {
    const topic = `test.${randomUUID()}`;
    const replicaId = `t7c-${randomUUID()}`;
    const consumer = replicaConsumer(replicaId);
    const idempotentConsumer = `t7c-consumer-${randomUUID()}`;
    let effects = 0;

    const bus = new OutboxEventBus();
    bus.configure({
      db: getPrisma(),
      redis: null,
      production: false,
      instanceId: replicaId,
      replayWindowMs: 60_000,
    });
    bus.subscribe(topic, (_payload, meta) => {
      if (!meta?.eventId) return;
      void bus.runIdempotent(idempotentConsumer, meta.eventId, () => {
        effects += 1;
      });
    });

    bus.publish(topic, { once: true });
    await bus.relay(); // live path
    // The handler runs the idempotent effect asynchronously; poll with awaits so
    // the event loop can actually progress (a sync spin would starve it).
    for (let i = 0; i < 100 && effects === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await bus.catchUp(); // replay path over the same row
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(effects).toBe(1);
    await getPrisma().processedEvent.deleteMany({ where: { consumer: idempotentConsumer } });
    await getPrisma().eventCursor.deleteMany({ where: { consumer } });
  });

  it('T7d retention: a replica cursor older than retention warns', async () => {
    const replicaId = `t7d-${randomUUID()}`;
    const consumer = replicaConsumer(replicaId);
    const warnings: string[] = [];
    const bus = new OutboxEventBus();
    bus.configure({
      db: getPrisma(),
      redis: null,
      production: false,
      instanceId: replicaId,
      logger: { warn: (m) => warnings.push(m), info: () => {} },
    });
    await getPrisma().eventCursor.upsert({
      where: { consumer },
      create: { consumer, lastId: null, lastAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      update: { lastAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    await bus.cleanup(7 * 24 * 60 * 60 * 1000);

    expect(warnings.some((w) => w.includes(consumer) && w.includes('retention'))).toBe(true);
    await getPrisma().eventCursor.deleteMany({ where: { consumer } });
  });

  it('T7e first boot: no cursor replays only events from now on (window configurable)', async () => {
    const topic = `test.${randomUUID()}`;
    // An old event exists before the replica ever started.
    await getPrisma().outboxEvent.create({
      data: { topic, payload: { body: JSON.stringify({ topic, payload: { old: true } }) } },
    });

    const replicaId = `t7e-${randomUUID()}`;
    const consumer = replicaConsumer(replicaId);
    const bus = new OutboxEventBus();
    bus.configure({ db: getPrisma(), redis: null, production: false, instanceId: replicaId });
    const seen: unknown[] = [];
    bus.subscribe(topic, (payload) => seen.push(payload));

    // Default window = 0: do not replay history.
    await bus.catchUp();
    expect(seen).toHaveLength(0);

    // With a window covering the row, it is replayed.
    const windowedId = `t7e-window-${randomUUID()}`;
    const windowed = replicaConsumer(windowedId);
    const windowedBus = new OutboxEventBus();
    windowedBus.configure({
      db: getPrisma(),
      redis: null,
      production: false,
      instanceId: windowedId,
      replayWindowMs: 60 * 60 * 1000,
    });
    const windowedSeen: unknown[] = [];
    windowedBus.subscribe(topic, (payload) => windowedSeen.push(payload));
    await windowedBus.catchUp();
    expect(windowedSeen).toContainEqual({ old: true });

    await getPrisma().eventCursor.deleteMany({ where: { consumer: { in: [consumer, windowed] } } });
  });

  it('T10 stable identity: the same instance id resumes its cursor instead of replaying', async () => {
    const topic = `test.${randomUUID()}`;
    const replicaId = `t10-${randomUUID()}`;
    const consumer = replicaConsumer(replicaId);

    const first = new OutboxEventBus();
    first.configure({
      db: getPrisma(),
      redis: null,
      production: false,
      instanceId: replicaId,
      replayWindowMs: 60_000,
    });
    const firstSeen: unknown[] = [];
    first.subscribe(topic, (payload) => firstSeen.push(payload));
    first.publish(topic, { restart: true });
    await first.catchUp();
    expect(firstSeen).toEqual([{ restart: true }]);

    // "Restart": a new process with the same STACKPANEL_INSTANCE_ID must not
    // replay what the previous process already consumed.
    const restarted = new OutboxEventBus();
    restarted.configure({
      db: getPrisma(),
      redis: null,
      production: false,
      instanceId: replicaId,
      replayWindowMs: 60_000,
    });
    const restartedSeen: unknown[] = [];
    restarted.subscribe(topic, (payload) => restartedSeen.push(payload));
    expect(await restarted.catchUp()).toBe(0);
    expect(restartedSeen).toHaveLength(0);

    expect(restarted.replicaConsumerId).toBe(consumer);
    await getPrisma().eventCursor.deleteMany({ where: { consumer } });
  });

  it('T11 boot order: start() before subscribers must not consume; startConsumption() recovers', async () => {
    // Audit 4B · B-1: in the real boot path `initInfra()` calls `start()`
    // *before* plugins activate and subscribe. `start()` must therefore leave
    // the replica cursor untouched, otherwise a restarting replica advances
    // past rows nobody listened for and loses them permanently.
    const topic = `test.${randomUUID()}`;
    const replicaId = `t11-${randomUUID()}`;
    const consumer = replicaConsumer(replicaId);
    await getPrisma().eventCursor.deleteMany({ where: { consumer } });

    // Another replica published while this one was offline.
    const a = new OutboxEventBus();
    bindLocal(a);
    a.publish(topic, { boot: true });
    const deadline = Date.now() + 4000;
    let row = await getPrisma().outboxEvent.findFirst({
      where: { topic },
      orderBy: { createdAt: 'desc' },
    });
    while (!row?.publishedAt && Date.now() < deadline) {
      await a.relay();
      await new Promise((resolve) => setTimeout(resolve, 25));
      row = await getPrisma().outboxEvent.findFirst({
        where: { topic },
        orderBy: { createdAt: 'desc' },
      });
    }
    expect(row?.publishedAt).not.toBeNull();

    // --- Boot phase: start() runs in initInfra(), before any subscriber.
    const b = new OutboxEventBus();
    b.configure({
      db: getPrisma(),
      redis: null,
      production: false,
      instanceId: replicaId,
      replayWindowMs: 60_000,
      catchUpIntervalMs: 50,
    });
    b.start();
    // Give the (buggy) boot-time catch-up every chance to run.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await getPrisma().eventCursor.findUnique({ where: { consumer } })).toBeNull();

    // --- Plugins activate and subscribe; only now may consumption begin.
    const seen: unknown[] = [];
    b.subscribe(topic, (payload) => seen.push(payload));
    expect(b.startConsumption()).toBe(true);
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([{ boot: true }]);

    // idempotent
    expect(b.startConsumption()).toBe(false);

    await b.stop();
    await getPrisma().eventCursor.deleteMany({ where: { consumer } });
  });

  it('T7 cursor is distinct from the cluster-wide observability cursor', async () => {
    await getPrisma().eventCursor.deleteMany({ where: { consumer: OUTBOX_CLUSTER_CONSUMER } });
    const replicaId = `t7-obs-${randomUUID()}`;
    const consumer = replicaConsumer(replicaId);
    const bus = new OutboxEventBus();
    bus.configure({
      db: getPrisma(),
      redis: null,
      production: false,
      instanceId: replicaId,
      replayWindowMs: 60_000,
    });
    const topic = `test.${randomUUID()}`;
    const seen: unknown[] = [];
    bus.subscribe(topic, (payload) => seen.push(payload));
    bus.publish(topic, { durable: true });
    await waitFor(() => seen.length === 1);
    await bus.relay();
    await bus.catchUp();

    // Relay advances the cluster cursor; catch-up advances the replica cursor.
    const cluster = await getPrisma().eventCursor.findUnique({
      where: { consumer: OUTBOX_CLUSTER_CONSUMER },
    });
    const replica = await getPrisma().eventCursor.findUnique({ where: { consumer } });
    expect(cluster?.lastAt).not.toBeNull();
    expect(replica?.lastAt).not.toBeNull();
    // Both consumed the same single row here, so the positions coincide; the
    // point is that they are independent rows with independent consumers.
    expect(consumer).not.toBe(OUTBOX_CLUSTER_CONSUMER);
    expect(replica?.lastId).not.toBeNull();

    const stats = await bus.outboxStats();
    expect(stats.cursorLagMs).toBeLessThan(10_000);
    expect(stats.replicaCursorLagMs).toBeLessThan(10_000);

    await getPrisma().eventCursor.deleteMany({ where: { consumer } });
  });
});

describe.skipIf(!dbAvailable || !redisAvailable)('OutboxEventBus (redis)', () => {
  it('exposes the redis client used for pub/sub', async () => {
    const redis = (await getRedis(REDIS_URL)) as RedisClient;
    expect(redis.status).toBeDefined();
  });
});
