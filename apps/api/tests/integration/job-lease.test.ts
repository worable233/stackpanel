import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeRedis } from '@stackpanel/db';
import { DbJobLease } from '../../src/jobs/lease.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';

/**
 * 对标 #12.5：跨副本单实例保证。
 *
 * 真实场景：两个副本同时到点，各自 `setInterval` 都触发了。谁执行由租约决定 ——
 * 只有一个副本的 `INSERT ... ON CONFLICT ... WHERE 已过期` 能命中，另一个拿到空
 * 结果集并跳过。租约过期后由下一轮接手，不需要死节点检测。
 */
const dbAvailable = await (async (): Promise<boolean> => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

const prefix = `test.lease.${randomUUID().slice(0, 8)}`;
const created: string[] = [];

function leaseJob(suffix: string): string {
  // 每个用例必须有独立任务名：同名任务配独立租约本身就是「稳态」，会让后一个
  // 用例被前一个用例的未过期租约挡住，测出来的失败是假的。
  const name = `${prefix}.${suffix}`;
  created.push(name);
  return name;
}

afterAll(async () => {
  if (created.length > 0) {
    await getPrisma().$executeRaw`DELETE FROM "kernel_job_leases" WHERE "name" = ANY(${created})`;
  }
  await closeRedis();
});

describe.skipIf(!dbAvailable)('DbJobLease', () => {
  it('两个副本抢同一个任务，只有一个抢到', async () => {
    const name = leaseJob('contend');
    const a = new DbJobLease(getPrisma(), 'replica-a');
    const b = new DbJobLease(getPrisma(), 'replica-b');

    expect(await a.tryAcquire(name, 5_000)).toBe(true);
    expect(await b.tryAcquire(name, 5_000)).toBe(false);
  });

  it('租约过期后另一个副本可以接手（持有者崩溃不需要清理）', async () => {
    const name = leaseJob('expire');
    const a = new DbJobLease(getPrisma(), 'replica-a');
    const b = new DbJobLease(getPrisma(), 'replica-b');

    expect(await a.tryAcquire(name, 30)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await b.tryAcquire(name, 5_000)).toBe(true);
  });

  it('不同任务互不阻塞', async () => {
    const first = leaseJob('independent-a');
    const second = leaseJob('independent-b');
    const lease = new DbJobLease(getPrisma(), 'replica-a');

    expect(await lease.tryAcquire(first, 5_000)).toBe(true);
    expect(await lease.tryAcquire(second, 5_000)).toBe(true);
  });

  it('同一副本连续抢同一任务：租约内第二次被自己挡住（不会自我放大频率）', async () => {
    const name = leaseJob('self');
    const lease = new DbJobLease(getPrisma(), 'replica-a');

    expect(await lease.tryAcquire(name, 5_000)).toBe(true);
    expect(await lease.tryAcquire(name, 5_000)).toBe(false);
  });
});
