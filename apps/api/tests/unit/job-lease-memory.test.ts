import { describe, expect, it, vi } from 'vitest';
import { leaseTtlMs } from '../../src/jobs/lease.ts';
import { MemoryJobBackend } from '../../src/jobs/memory-backend.ts';

/**
 * 对标 #12.5：进程内后端在集群下会「每个副本各跑一份」。租约把「谁执行」这件事
 * 从「每个定时器都跑」改成「抢到租约的那个跑」，其余副本安静跳过。
 *
 * 这里只锁行为契约；数据库侧的抢占语义在 `tests/integration/job-lease.test.ts`。
 */
function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(check, 10);
    };
    check();
  });
}

describe('MemoryJobBackend 租约', () => {
  it('抢到租约才执行，没抢到静默跳过', async () => {
    const ran: string[] = [];
    const backend = new MemoryJobBackend({
      logger: { warn: () => undefined },
      guard: {
        // 第一轮给，之后不给：模拟另一个副本先抢到。
        tryAcquire: vi.fn(async () => ran.length === 0),
      },
    });
    backend.handle('k.sweep', () => {
      ran.push('tick');
    });
    await backend.schedule({ fullName: 'k.sweep', schedule: { everyMs: 20 }, payload: undefined });

    await waitFor(() => ran.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await backend.stop();

    // 只跑了一次：后续 tick 全部被租约挡掉，不是「每 20ms 跑一次」。
    expect(ran).toEqual(['tick']);
  });

  it('租约出错按「没抢到」处理：跳过本轮，不执行、不抛给定时器', async () => {
    const ran: string[] = [];
    const warned: string[] = [];
    const backend = new MemoryJobBackend({
      logger: { warn: (m) => warned.push(m) },
      guard: {
        tryAcquire: async () => {
          throw new Error('connection reset');
        },
      },
    });
    backend.handle('k.sweep', () => {
      ran.push('tick');
    });
    await backend.schedule({ fullName: 'k.sweep', schedule: { everyMs: 20 }, payload: undefined });

    await waitFor(() => warned.length >= 1);
    await backend.stop();

    expect(ran).toEqual([]);
    // 宁可这一轮不跑（下一轮补），也不能因数据库抖一下变成重复执行。
    expect(warned[0]).toContain('connection reset');
  });

  it('不给租约时保持原行为（单副本开发）', async () => {
    const ran: string[] = [];
    const backend = new MemoryJobBackend({ logger: { warn: () => undefined } });
    backend.handle('k.sweep', () => {
      ran.push('tick');
    });
    await backend.schedule({ fullName: 'k.sweep', schedule: { everyMs: 20 }, payload: undefined });

    await waitFor(() => ran.length >= 2);
    await backend.stop();
    expect(ran.length).toBeGreaterThanOrEqual(2);
  });

  it('租约时长取一个间隔：不把有效频率压到几倍间隔以下', () => {
    expect(leaseTtlMs(2_000)).toBe(2_000);
    expect(leaseTtlMs(60_000)).toBe(60_000);
    // 下限 1s：2s 一轮的任务不该拿到 20ms 的租约（会与下一轮重叠）。
    expect(leaseTtlMs(20)).toBe(1_000);
    // 上限 5 分钟：崩溃后最多 5 分钟就有别的副本接手。
    expect(leaseTtlMs(24 * 60 * 60_000)).toBe(5 * 60_000);
  });
});
