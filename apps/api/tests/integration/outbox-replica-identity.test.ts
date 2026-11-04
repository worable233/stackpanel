import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedis } from '@stackpanel/db';
import { OutboxEventBus, replicaConsumer, resolveInstanceId } from '../../src/plugins/events.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';

/**
 * 审计 #4 · 多节点验收的**副本身份唯一性**。
 *
 * 持久消费游标按 `replica:<instanceId>` 分键。如果同一台主机上的两个副本
 * 解析出同一个 id，它们就共用一条游标：A 消费完推进游标，B 的 catch-up 从
 * 新游标开始 → B 永久错过那些行。这正是 W3 要消除的丢事件形态，只是从
 * 「重启」搬到了「同机多副本」。
 *
 * 这里锁住默认身份的判定顺序，避免以后再把判别位丢掉。
 */
const dbAvailable = await (async (): Promise<boolean> => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

afterAll(async () => {
  await closeRedis();
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('resolveInstanceId 稳定性与唯一性', () => {
  it('显式 STACKPANEL_INSTANCE_ID 优先，且归一化后可安全用作游标键', () => {
    const original = process.env.STACKPANEL_INSTANCE_ID;
    try {
      process.env.STACKPANEL_INSTANCE_ID = 'Node A/eu-west#1';
      expect(resolveInstanceId()).toBe('node-a-eu-west-1');
    } finally {
      if (original === undefined) delete process.env.STACKPANEL_INSTANCE_ID;
      else process.env.STACKPANEL_INSTANCE_ID = original;
    }
  });

  it('未显式配置时，同机不同端口的两个副本必须解析出不同身份', () => {
    const original = process.env.STACKPANEL_INSTANCE_ID;
    const originalPort = process.env.API_PORT;
    const originalInstance = process.env.NODE_APP_INSTANCE;
    try {
      delete process.env.STACKPANEL_INSTANCE_ID;
      delete process.env.NODE_APP_INSTANCE;
      process.env.API_PORT = '3101';
      const a = resolveInstanceId();
      process.env.API_PORT = '3102';
      const b = resolveInstanceId();
      expect(a).not.toBe(b);
    } finally {
      if (original === undefined) delete process.env.STACKPANEL_INSTANCE_ID;
      else process.env.STACKPANEL_INSTANCE_ID = original;
      if (originalPort === undefined) delete process.env.API_PORT;
      else process.env.API_PORT = originalPort;
      if (originalInstance === undefined) delete process.env.NODE_APP_INSTANCE;
      else process.env.NODE_APP_INSTANCE = originalInstance;
    }
  });

  it('PM2 cluster 的 NODE_APP_INSTANCE 区分同一端口上的多个实例', () => {
    const original = process.env.STACKPANEL_INSTANCE_ID;
    const originalInstance = process.env.NODE_APP_INSTANCE;
    const originalPort = process.env.API_PORT;
    try {
      delete process.env.STACKPANEL_INSTANCE_ID;
      process.env.API_PORT = '3001';
      process.env.NODE_APP_INSTANCE = '0';
      const zero = resolveInstanceId();
      process.env.NODE_APP_INSTANCE = '1';
      const one = resolveInstanceId();
      expect(zero).not.toBe(one);
    } finally {
      if (original === undefined) delete process.env.STACKPANEL_INSTANCE_ID;
      else process.env.STACKPANEL_INSTANCE_ID = original;
      if (originalInstance === undefined) delete process.env.NODE_APP_INSTANCE;
      else process.env.NODE_APP_INSTANCE = originalInstance;
      if (originalPort === undefined) delete process.env.API_PORT;
      else process.env.API_PORT = originalPort;
    }
  });

  it('同一输入重复解析结果稳定（重启续位，而不是每次换新游标）', () => {
    const original = process.env.STACKPANEL_INSTANCE_ID;
    try {
      process.env.STACKPANEL_INSTANCE_ID = 'stable-replica';
      expect(resolveInstanceId()).toBe(resolveInstanceId());
    } finally {
      if (original === undefined) delete process.env.STACKPANEL_INSTANCE_ID;
      else process.env.STACKPANEL_INSTANCE_ID = original;
    }
  });

  it('超长身份被截断但保持不碰撞', () => {
    const original = process.env.STACKPANEL_INSTANCE_ID;
    try {
      const base = 'x'.repeat(200);
      process.env.STACKPANEL_INSTANCE_ID = `${base}a`;
      const first = resolveInstanceId();
      process.env.STACKPANEL_INSTANCE_ID = `${base}b`;
      const second = resolveInstanceId();
      expect(first.length).toBeLessThanOrEqual(96);
      expect(first).not.toBe(second);
    } finally {
      if (original === undefined) delete process.env.STACKPANEL_INSTANCE_ID;
      else process.env.STACKPANEL_INSTANCE_ID = original;
    }
  });
});

describe.skipIf(!dbAvailable)('同机多副本不得共用游标', () => {
  it('两个不同身份的副本各自补齐同一行', async () => {
    const topic = `fault.identity.${randomUUID()}`;
    const idA = `samehost-a-${randomUUID()}`;
    const idB = `samehost-b-${randomUUID()}`;
    await getPrisma().eventCursor.deleteMany({
      where: { consumer: { in: [replicaConsumer(idA), replicaConsumer(idB)] } },
    });

    const a = new OutboxEventBus();
    a.configure({
      db: getPrisma(),
      redis: null,
      production: false,
      instanceId: idA,
      replayWindowMs: 10 * 60 * 1000,
      // 轮询间隔必须显式给短值。默认是 2s 起步、空转翻倍、封顶 30s
      // （`plugins/events.ts` 的自适应退避），而这里等的是「一次真实的数据库
      // 轮询 + 投递」。空转几轮后间隔就到 30s，55s 预算内可能只触发一两次 ——
      // 并行跑时连接池被 60+ 个集成套件占满，就更容易打穿。
      catchUpIntervalMs: 50,
      catchUpMaxIntervalMs: 100,
    });
    const b = new OutboxEventBus();
    b.configure({
      db: getPrisma(),
      redis: null,
      production: false,
      instanceId: idB,
      replayWindowMs: 10 * 60 * 1000,
      catchUpIntervalMs: 50,
      catchUpMaxIntervalMs: 100,
    });
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.subscribe(topic, (payload) => seenA.push(payload));
    b.subscribe(topic, (payload) => seenB.push(payload));

    a.publish(topic, { both: true });
    /**
     * 这里**不能**用 `startConsumption()`：它起的自适应轮询会和下面显式的
     * `catchUp()` 竞争同一个游标 —— 轮询先把游标推到最新，紧接着的手动
     * catchUp 就什么也读不到，`seenA` 为空而 `seenB` 有值（实测就是这个症状）。
     *
     * 这条用例要验证的是「两个副本各自按自己的游标补齐同一行」，所以把投递
     * 时机完全交给测试控制：反复显式 catchUp 直到两侧都收到。
     */
    const deadline = Date.now() + 20_000;
    while ((seenA.length === 0 || seenB.length === 0) && Date.now() < deadline) {
      await a.catchUp();
      await b.catchUp();
      if (seenA.length === 0 || seenB.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    expect(seenA).toEqual([{ both: true }]);
    expect(seenB).toEqual([{ both: true }]);

    await a.stop();
    await b.stop();
    await getPrisma().eventCursor.deleteMany({
      where: { consumer: { in: [replicaConsumer(idA), replicaConsumer(idB)] } },
    });
  }, 40_000);
});
