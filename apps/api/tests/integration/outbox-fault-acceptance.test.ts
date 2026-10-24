import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedis, getRedis, pingRedis, type RedisClient } from '@stackpanel/db';
import { OutboxEventBus, replicaConsumer } from '../../src/plugins/events.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';

/**
 * 审计 #4 的**故障 / 多节点验收**（TRACK 里 `[~]` 的唯一剩余门槛）。
 *
 * 与 `outbox-event-bus.test.ts`（T1–T11，单进程逻辑与契约）互补：这里只放
 * 「真实故障下行为是否仍成立」的场景，全部跑真实 PostgreSQL，Redis 可达时
 * 走真实 Pub/Sub、不可达时用注入的故障客户端代替。
 *
 * 覆盖：
 *   F1 两副本：副本 B 离线期间 A 发布并投递 → B 上线按自己的游标补齐（至少一次）
 *   F2 两副本：同一行被 A/B 同时 relay，只有一个副本真正投递（不双投）
 *   F3 Pub/Sub 断线：广播通道不可用，持久 catch-up 仍能补齐（不依赖广播）
 *   F4 崩溃点：本地投递后、标记 published 前崩溃 → 下一轮重投，消费幂等吸收
 *   F5 崩溃点：游标推进前崩溃 → 重启后重投同一行，不跳过
 *   F6 retention：cleanup 只裁剪已发布行，绝不删未发布行
 *   F7 多副本游标隔离：两个副本各自推进自己的游标，互不影响
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Wait until `probe` returns a non-null value, then return it.
 *
 * `waitFor` only tells you the condition became true; callers that then read
 * the same row can still observe a stale value. Use this when the assertion is
 * about the value itself.
 */
async function waitForValue<T>(
  probe: () => Promise<T | null>,
  timeoutMs = 5000,
): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Bind a replica to the real outbox, with a stable identity and a wide replay window. */
function replica(instanceId: string, overrides: Record<string, unknown> = {}) {
  const bus = new OutboxEventBus();
  bus.configure({
    db: getPrisma(),
    redis: null,
    production: false,
    instanceId,
    replayWindowMs: 10 * 60 * 1000,
    intervalMs: 60 * 60 * 1000,
    catchUpIntervalMs: 60 * 60 * 1000,
    ...overrides,
  });
  return bus;
}

/** A Redis stand-in whose Pub/Sub is dead but whose writes still fail loudly. */
function deadPubSubRedis(): RedisClient {
  return {
    publish: async () => {
      throw new Error('pubsub unavailable');
    },
    duplicate: () => ({
      on: () => undefined,
      subscribe: async () => undefined,
      quit: async () => undefined,
    }),
  } as unknown as RedisClient;
}

/** Relay until the row is published (bounded), so tests never spin forever. */
async function drain(bus: OutboxEventBus, topic: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    await bus.relay();
    const row = await getPrisma().outboxEvent.findFirst({
      where: { topic },
      orderBy: { createdAt: 'desc' },
    });
    if (row?.publishedAt) return;
    if (Date.now() > deadline) throw new Error(`row for ${topic} never published`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * `publish` persists asynchronously, so a test that relays or catches up
 * immediately after it races the insert. Wait for the row to exist first.
 */
async function publishAndPersist(
  bus: OutboxEventBus,
  topic: string,
  payload: unknown,
): Promise<void> {
  bus.publish(topic, payload);
  await waitFor(async () => {
    const row = await getPrisma().outboxEvent.findFirst({ where: { topic } });
    return row !== null;
  });
}

describe.skipIf(!dbAvailable)('#4 故障 / 多节点验收', () => {
  it('F1 离线副本上线后按自己的游标补齐错过的行', async () => {
    const topic = `fault.f1.${randomUUID()}`;
    const replicaB = `f1-b-${randomUUID()}`;
    const consumerB = replicaConsumer(replicaB);
    await getPrisma().eventCursor.deleteMany({ where: { consumer: consumerB } });

    // A 在线发布并投递；B 此刻完全不存在（进程已停）。
    const a = replica(`f1-a-${randomUUID()}`);
    const seenA: unknown[] = [];
    a.subscribe(topic, (payload) => seenA.push(payload));
    await publishAndPersist(a, topic, { missedByB: true });
    await drain(a, topic);
    expect(seenA).toEqual([{ missedByB: true }]);

    // B 重启（同一 STACKPANEL_INSTANCE_ID 语义），带自己的订阅者。
    const b = replica(replicaB);
    const seenB: unknown[] = [];
    b.subscribe(topic, (payload) => seenB.push(payload));
    b.startConsumption();
    await waitFor(() => seenB.length === 1);

    expect(seenB).toEqual([{ missedByB: true }]);
    // 游标是在 `deliver()` **之后**异步推进的：`deliver` 同步调用监听器，
    // 订阅者立刻就能看到 payload，而 `advanceReplicaCursor` 还要一次 DB 往返。
    // 只等 `seenB.length === 1` 会在 CI 慢机器上赢下这场竞态，随后断言游标非空
    // 就会假失败（本地快，通常看不出来）。所以先等游标落库，再断言。
    const cursor = await waitForValue(async () => {
      const row = await getPrisma().eventCursor.findUnique({ where: { consumer: consumerB } });
      return row?.lastId ? row : null;
    });
    expect(cursor?.lastId).not.toBeNull();

    // 幂等：再跑一轮不会重投。
    expect(await b.catchUp()).toBe(0);
    await b.stop();
    await getPrisma().eventCursor.deleteMany({ where: { consumer: consumerB } });
  }, 30_000);

  it('F2 两副本同时 relay 同一行时只投递一次', async () => {
    const topic = `fault.f2.${randomUUID()}`;
    const a = replica(`f2-a-${randomUUID()}`);
    const b = replica(`f2-b-${randomUUID()}`);
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.subscribe(topic, (payload) => seenA.push(payload));
    b.subscribe(topic, (payload) => seenB.push(payload));

    await publishAndPersist(a, topic, { once: true });
    await Promise.all([a.relay(), b.relay()]);
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 原子认领保证跨副本只投一次（不是「每个副本各一次」）。
    expect(seenA.length + seenB.length).toBe(1);
  }, 30_000);

  it('F3 Pub/Sub 断线时持久 catch-up 仍补齐（不依赖广播）', async () => {
    const topic = `fault.f3.${randomUUID()}`;
    const replicaB = `f3-b-${randomUUID()}`;
    const consumerB = replicaConsumer(replicaB);
    await getPrisma().eventCursor.deleteMany({ where: { consumer: consumerB } });

    // A 用死掉的 Pub/Sub：广播发不出去，但行仍然落库。
    const a = replica(`f3-a-${randomUUID()}`, { redis: deadPubSubRedis() });
    await publishAndPersist(a, topic, { broadcastLost: true });
    // 广播失败 → 行保持未发布（attempts 递增），这正是「广播通道挂掉」的真实形态。
    const deadline = Date.now() + 3000;
    let row = await getPrisma().outboxEvent.findFirst({
      where: { topic },
      orderBy: { createdAt: 'desc' },
    });
    while (!row?.lastError && Date.now() < deadline) {
      await a.relay();
      await new Promise((resolve) => setTimeout(resolve, 25));
      row = await getPrisma().outboxEvent.findFirst({
        where: { topic },
        orderBy: { createdAt: 'desc' },
      });
    }
    expect(row?.lastError).toContain('pubsub unavailable');
    expect(row?.publishedAt).toBeNull();

    // B 只靠持久游标补齐，完全不依赖 Pub/Sub。
    const b = replica(replicaB);
    const seen: unknown[] = [];
    b.subscribe(topic, (payload) => seen.push(payload));
    await b.catchUp();

    expect(seen).toEqual([{ broadcastLost: true }]);
    await b.stop();
    await getPrisma().eventCursor.deleteMany({ where: { consumer: consumerB } });
    await getPrisma().outboxEvent.deleteMany({ where: { topic } });
  }, 30_000);

  it('F4 投递后、标记已发布前崩溃 → 重投但副作用只发生一次', async () => {
    const topic = `fault.f4.${randomUUID()}`;
    const bus = replica(`f4-${randomUUID()}`, { redis: deadPubSubRedis(), maxAttempts: 10 });
    const guard = `f4-consumer-${randomUUID()}`;
    let effects = 0;
    bus.subscribe(topic, (_payload, meta) => {
      if (!meta?.eventId) return;
      void bus.runIdempotent(guard, meta.eventId, () => {
        effects += 1;
      });
    });

    await publishAndPersist(bus, topic, { crashy: true });
    // The relay is re-entrancy-guarded, so a pass racing the persist nudge is a
    // no-op — the periodic timer would cover it in production, but this test
    // pins the interval to an hour, so drive it explicitly.
    const rowFor = () =>
      getPrisma().outboxEvent.findFirst({ where: { topic }, orderBy: { createdAt: 'desc' } });
    // 第一次 relay：本地投递成功，随后 publishRemote 抛错 → 行未标记已发布。
    const firstDeadline = Date.now() + 5000;
    for (;;) {
      await bus.relay();
      const current = await rowFor();
      if ((current?.attempts ?? 0) >= 1) break;
      if (Date.now() > firstDeadline) throw new Error('first relay attempt never ran');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await waitFor(() => effects === 1);
    let row = await rowFor();
    expect(row?.publishedAt).toBeNull();
    expect(row?.attempts).toBe(1);

    // 「重启」后同一行被再次投递；消费幂等吸收，副作用仍是 1 次。
    await getPrisma().outboxEvent.updateMany({
      where: { topic },
      data: { nextAttemptAt: new Date(0), lockedAt: null },
    });
    const secondDeadline = Date.now() + 5000;
    for (;;) {
      await bus.relay();
      const current = await rowFor();
      if ((current?.attempts ?? 0) >= 2) break;
      if (Date.now() > secondDeadline) throw new Error('second relay attempt never ran');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    row = await rowFor();
    expect(row?.attempts).toBe(2);
    expect(effects).toBe(1);

    await getPrisma().processedEvent.deleteMany({ where: { consumer: guard } });
    await getPrisma().outboxEvent.deleteMany({ where: { topic } });
  }, 30_000);

  it('F5 推进游标前崩溃 → 重启后重投同一行，不跳过', async () => {
    const topic = `fault.f5.${randomUUID()}`;
    const replicaB = `f5-b-${randomUUID()}`;
    const consumerB = replicaConsumer(replicaB);
    await getPrisma().eventCursor.deleteMany({ where: { consumer: consumerB } });

    // 行已存在（别的副本写入），B 从未消费过。
    await getPrisma().outboxEvent.create({
      data: { topic, payload: { body: JSON.stringify({ topic, payload: { v: 1 } }) } },
    });

    // 第一次消费：投递后立刻「崩溃」（不推进游标）。
    const crashing = replica(replicaB);
    const first: unknown[] = [];
    crashing.subscribe(topic, (payload) => first.push(payload));
    const delivered = await crashing.catchUp();
    expect(delivered).toBeGreaterThanOrEqual(1);
    expect(first).toEqual([{ v: 1 }]);
    await getPrisma().eventCursor.deleteMany({ where: { consumer: consumerB } });

    // 重启：同一行必须再次被投递（at-least-once，而不是「悄悄跳过」）。
    const restarted = replica(replicaB);
    const second: unknown[] = [];
    restarted.subscribe(topic, (payload) => second.push(payload));
    await restarted.catchUp();
    expect(second).toEqual([{ v: 1 }]);

    await restarted.stop();
    await getPrisma().eventCursor.deleteMany({ where: { consumer: consumerB } });
    await getPrisma().outboxEvent.deleteMany({ where: { topic } });
  }, 30_000);

  it('F6 retention 裁剪只删已发布行，未发布/停执行永久保留', async () => {
    const bus = replica(`f6-${randomUUID()}`);
    const publishedTopic = `fault.f6.published.${randomUUID()}`;
    const pendingTopic = `fault.f6.pending.${randomUUID()}`;

    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await getPrisma().outboxEvent.create({
      data: {
        topic: publishedTopic,
        payload: { body: JSON.stringify({ topic: publishedTopic, payload: {} }) },
        createdAt: old,
        publishedAt: old,
      },
    });
    await getPrisma().outboxEvent.create({
      data: {
        topic: pendingTopic,
        payload: { body: JSON.stringify({ topic: pendingTopic, payload: {} }) },
        createdAt: old,
      },
    });

    const removed = await bus.cleanup(7 * 24 * 60 * 60 * 1000);
    expect(removed).toBeGreaterThanOrEqual(1);

    const publishedLeft = await getPrisma().outboxEvent.count({ where: { topic: publishedTopic } });
    const pendingLeft = await getPrisma().outboxEvent.count({ where: { topic: pendingTopic } });
    expect(publishedLeft).toBe(0);
    // 未发布的行即便远超保留期也不能被删：删了就等于丢事件。
    expect(pendingLeft).toBe(1);

    await getPrisma().outboxEvent.deleteMany({ where: { topic: pendingTopic } });
  }, 30_000);

  it('F7 两个副本各自推进自己的游标，互不影响', async () => {
    const topic = `fault.f7.${randomUUID()}`;
    const idA = `f7-a-${randomUUID()}`;
    const idB = `f7-b-${randomUUID()}`;
    const consumerA = replicaConsumer(idA);
    const consumerB = replicaConsumer(idB);
    await getPrisma().eventCursor.deleteMany({
      where: { consumer: { in: [consumerA, consumerB] } },
    });

    const a = replica(idA);
    const b = replica(idB);
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.subscribe(topic, (payload) => seenA.push(payload));
    b.subscribe(topic, (payload) => seenB.push(payload));

    await publishAndPersist(a, topic, { forBoth: true });
    await a.catchUp();
    // A 已消费；B 此时还没跑，游标必须仍是独立的（不能共享一个全局游标）。
    expect(seenA).toEqual([{ forBoth: true }]);
    const cursorA = await getPrisma().eventCursor.findUnique({ where: { consumer: consumerA } });
    expect(cursorA?.lastId).not.toBeNull();
    expect(await getPrisma().eventCursor.findUnique({ where: { consumer: consumerB } })).toBeNull();

    await b.catchUp();
    expect(seenB).toEqual([{ forBoth: true }]);
    const cursorB = await getPrisma().eventCursor.findUnique({ where: { consumer: consumerB } });
    expect(cursorB?.lastId).toBe(cursorA?.lastId);

    await a.stop();
    await b.stop();
    await getPrisma().eventCursor.deleteMany({
      where: { consumer: { in: [consumerA, consumerB] } },
    });
  }, 30_000);

  it.skipIf(!redisAvailable)(
    'F8 真实 Redis：一个副本进程停掉后重启，广播丢失仍靠游标补齐',
    async () => {
      const topic = `fault.f8.${randomUUID()}`;
      const idA = `f8-a-${randomUUID()}`;
      const idB = `f8-b-${randomUUID()}`;
      const consumerB = replicaConsumer(idB);
      await getPrisma().eventCursor.deleteMany({ where: { consumer: consumerB } });

      const redis = await getRedis(REDIS_URL);
      const a = replica(idA, { redis });
      await a.start();
      // B 先正常消费一行，留下自己的游标，这样重启后是**续位**而不是「首次启动窗口」。
      const warmupTopic = `fault.f8.warmup.${randomUUID()}`;
      const b = replica(idB, { redis });
      const warmupSeen: unknown[] = [];
      b.subscribe(warmupTopic, (payload) => warmupSeen.push(payload));
      await b.start();
      b.startConsumption();
      await publishAndPersist(a, warmupTopic, { warmup: true });
      await waitFor(() => warmupSeen.length === 1);
      expect(
        await getPrisma().eventCursor.findUnique({ where: { consumer: consumerB } }),
      ).not.toBeNull();

      try {
        // B 停掉消费（模拟进程被 kill），A 正常发布并广播。
        await b.stop();
        await publishAndPersist(a, topic, { afterBKill: true });
        await drain(a, topic);

        // B 重启：广播早就错过了，只能靠持久游标补齐。
        const restarted = replica(idB, { redis });
        const seen: unknown[] = [];
        restarted.subscribe(topic, (payload) => seen.push(payload));
        await restarted.start();
        restarted.startConsumption();
        await waitFor(() => seen.length === 1);

        expect(seen).toEqual([{ afterBKill: true }]);
        await restarted.stop();
      } finally {
        await a.stop();
        await getPrisma().eventCursor.deleteMany({ where: { consumer: consumerB } });
      }
    },
    40_000,
  );
});
