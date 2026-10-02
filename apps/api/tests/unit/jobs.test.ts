import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedis, getRedis, pingRedis } from '@stackpanel/db';
import { createKernelJobContext } from '../../src/jobs/kernel-jobs.ts';
import { MemoryJobBackend } from '../../src/jobs/memory-backend.ts';
import { BullMqJobBackend } from '../../src/jobs/bullmq-backend.ts';
import type { JobBackend } from '../../src/jobs/types.ts';

/**
 * Job subsystem (S6). The in-process backend verifies the contract (namespacing,
 * dispatch, owner teardown) hermetically. Redis-gated cases verify the cluster
 * guarantees BullMQ provides: one scheduler per id and one execution per job.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
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

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('MemoryJobBackend', () => {
  const logger = { warn: () => undefined };

  it('namespaces plugin job names and dispatches to the owning handler', async () => {
    const backend = new MemoryJobBackend({ logger });
    const seen: unknown[] = [];
    const jobs = createKernelJobContext('store', backend);
    jobs.handle('sync', async (payload) => {
      seen.push(payload);
    });

    await jobs.enqueue('sync', { n: 1 });
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([{ n: 1 }]);
  });

  it('does not cross namespaces between owners', async () => {
    const backend = new MemoryJobBackend({ logger });
    const a: string[] = [];
    const b: string[] = [];
    createKernelJobContext('alpha', backend).handle('run', () => void a.push('a'));
    createKernelJobContext('beta', backend).handle('run', () => void b.push('b'));

    await createKernelJobContext('alpha', backend).enqueue('run', null);
    await waitFor(() => a.length === 1);
    expect(b).toHaveLength(0);
  });

  it('runs a recurring schedule until the owner is removed', async () => {
    const backend = new MemoryJobBackend({ logger });
    const ticks: number[] = [];
    const jobs = createKernelJobContext('ticker', backend);
    jobs.handle('tick', () => void ticks.push(1));
    await jobs.schedule('tick', { everyMs: 30 });

    await waitFor(() => ticks.length >= 1);
    await backend.removeByOwner('ticker');
    const after = ticks.length;
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(ticks.length).toBe(after);
  });

  it('retries a failing handler up to the attempt budget', async () => {
    const backend = new MemoryJobBackend({ logger });
    let attempts = 0;
    const jobs = createKernelJobContext('flaky', backend);
    jobs.handle('boom', () => {
      attempts += 1;
      throw new Error('nope');
    });
    await jobs.enqueue('boom', null, { attempts: 3, backoffMs: 10 });
    await waitFor(() => attempts === 3);
    expect(attempts).toBe(3);
  });

  it('supports delayed enqueue', async () => {
    const backend = new MemoryJobBackend({ logger });
    const seen: number[] = [];
    const jobs = createKernelJobContext('delayed', backend);
    jobs.handle('later', () => void seen.push(Date.now()));
    const start = Date.now();
    await jobs.enqueue('later', null, { delayMs: 60 });
    await waitFor(() => seen.length === 1);
    expect((seen[0] ?? 0) - start).toBeGreaterThanOrEqual(50);
  });
});

describe.skipIf(!redisAvailable)('BullMqJobBackend (redis)', () => {
  const logger = { info: () => undefined, warn: () => undefined };

  it('keeps one scheduler per id and one execution per job across replicas', async () => {
    const suffix = randomUUID().slice(0, 8);
    const jobName = `it.${suffix}.tick`;
    const executions: string[] = [];
    const backendA: JobBackend = new BullMqJobBackend({ redisUrl: REDIS_URL, logger });
    const backendB: JobBackend = new BullMqJobBackend({ redisUrl: REDIS_URL, logger });
    backendA.handle(jobName, () => void executions.push('A'));
    backendB.handle(jobName, () => void executions.push('B'));
    await backendA.start();
    await backendB.start();
    try {
      await backendA.schedule({ fullName: jobName, schedule: { everyMs: 120 }, payload: null });
      // Both replicas declare the same scheduler id; only one exists in Redis.
      await backendB.schedule({ fullName: jobName, schedule: { everyMs: 120 }, payload: null });
      await waitFor(() => executions.length >= 1, 6000);
      // Exactly one replica handled the tick.
      expect(executions.length).toBe(1);
    } finally {
      await backendA.removeByOwner(`it.${suffix}`);
      await backendB.removeByOwner(`it.${suffix}`);
      await backendA.stop();
      await backendB.stop();
    }
  }, 20_000);
});
