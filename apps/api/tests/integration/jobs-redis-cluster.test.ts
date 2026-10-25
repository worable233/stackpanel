import { Queue } from 'bullmq';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { REDIS_KEY_PREFIX } from '@stackpanel/sdk';
import { BullMqJobBackend, KERNEL_QUEUE_NAME } from '../../src/jobs/bullmq-backend.ts';
import { redisConnectionOptions } from '../../src/jobs/redis-connection.ts';

/**
 * 集群语义的实测（对标 #12.5 的验收门槛「双实例只执行一次」）。
 *
 * 之前这条只有**推论**：`bullmq-backend.ts` 的注释写着「BullMQ 保证一个 job 只被
 * 一个 worker 取走，`upsertJobScheduler` 每个 id 只有一份调度」。注释不是证据 ——
 * 这里用同一个 Redis 起两个独立的 backend（各自 worker，等价于两个副本），
 * 把「只执行一次」变成可复现的断言。
 *
 * 需要真实 Redis：设 `TEST_REDIS_URL`（如 `redis://127.0.0.1:6379/9`）才跑，
 * 否则整组跳过 —— 不给 CI 引入必须常驻的 Redis 依赖。务必用**独立 db**，
 * 测试结束会 `obliterate` 整个队列。
 */
const REDIS_URL = process.env.TEST_REDIS_URL ?? '';

/**
 * 只允许在**独立 db** 上跑：清理用 `obliterate` 会删掉整个队列，
 * 指到 db 0（开发/生产的默认库）就等于把线上排队任务清空。
 */
function dedicatedDb(url: string): boolean {
  if (!url) return false;
  const db = new URL(url).pathname.replace(/^\//, '');
  return Number(db) >= 1;
}

const suite = dedicatedDb(REDIS_URL) ? describe : describe.skip;

const silent = { info: () => {}, warn: () => {} };

function backend(): BullMqJobBackend {
  return new BullMqJobBackend({ redisUrl: REDIS_URL, logger: silent });
}

function inspectQueue(): Queue {
  return new Queue(KERNEL_QUEUE_NAME, {
    connection: redisConnectionOptions(REDIS_URL),
    prefix: REDIS_KEY_PREFIX.bull,
  });
}

const started: BullMqJobBackend[] = [];

function track(b: BullMqJobBackend): BullMqJobBackend {
  started.push(b);
  return b;
}

suite('BullMQ 集群语义（双实例共用一个 Redis）', () => {
  afterEach(async () => {
    while (started.length) await started.pop()?.stop();
    const queue = inspectQueue();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  });

  afterAll(() => {
    // 组内已清理；此处仅保留给 future 用例挂全局钩子。
  });

  it('两个副本都声明同一个调度时，Redis 里只有一份', async () => {
    const name = `test.redis.single-scheduler.${Date.now()}`;
    const a = track(backend());
    const b = track(backend());
    for (const instance of [a, b]) {
      await instance.schedule({ fullName: name, schedule: { everyMs: 60_000 }, payload: null });
    }
    await a.start();
    await b.start();

    const queue = inspectQueue();
    const schedulers = await queue.getJobSchedulers(0, -1, true);
    await queue.close();

    // 关键：两个副本各自 `upsertJobScheduler` 同一个 id，结果仍是一份调度，
    // 否则每个副本都会按自己的节奏各发一遍任务。
    expect(schedulers.filter((entry) => entry.key === name)).toHaveLength(1);
  }, 30_000);

  it('两个副本同时运行时，一次 tick 只执行一次', async () => {
    const name = `test.redis.single-run.${Date.now()}`;
    const runs: number[] = [];
    const everyMs = 1_000;
    for (const instance of [track(backend()), track(backend())]) {
      instance.handle(name, async () => {
        runs.push(Date.now());
      });
      await instance.schedule({ fullName: name, schedule: { everyMs }, payload: null });
    }
    for (const instance of started) await instance.start();

    // 每个副本的并发都是默认值，所以「同一毫秒附近被执行两次」只可能来自
    // 「两个副本各取走了同一个 job」——这正是要证伪的东西。
    await new Promise((resolve) => setTimeout(resolve, 3_200));

    expect(runs.length).toBeGreaterThanOrEqual(2);
    // 间隔 1s 的调度在 3.2s 内不可能出现 4 次以上；重复执行会是 2 倍。
    expect(runs.length).toBeLessThanOrEqual(4);
    const gap = runs.slice(1).map((at, index) => at - (runs[index] ?? 0));
    expect(Math.min(...gap)).toBeGreaterThan(400);
  }, 30_000);

  it('两个副本用同一个 jobId 入队，只执行一次', async () => {
    const name = `test.redis.dedup.${Date.now()}`;
    const jobId = `dedupe-${Date.now()}`;
    const runs: unknown[] = [];
    const [a, b] = [track(backend()), track(backend())];
    for (const instance of [a, b]) {
      instance.handle(name, async (payload) => {
        runs.push(payload);
      });
    }
    await a.start();
    await b.start();

    await Promise.all([a.enqueue(name, { n: 1 }, { jobId }), b.enqueue(name, { n: 2 }, { jobId })]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // BullMQ 的 jobId 去重是「等待中/延迟中的同 id 只留一个」。
    expect(runs).toHaveLength(1);
  }, 30_000);
});
