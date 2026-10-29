import { afterEach, describe, expect, it, vi } from 'vitest';
import { CronParseError, matchesCron, nextCronFireMs, parseCron } from '../../src/jobs/cron.ts';
import { MemoryJobBackend } from '../../src/jobs/memory-backend.ts';
import { createKernelJobContext, getJobRuntime } from '../../src/jobs/kernel-jobs.ts';
import { describeSchedules } from '../../src/jobs/index.ts';

/**
 * In-process scheduling (ADR-0013 / audit E-10).
 *
 * `{ cron }` schedules used to be dropped without Redis, so scheduled work
 * (expiry sweeps, scheduled syncs, publish sweeps) silently never ran on a
 * single-node deployment. Redis is only needed to coordinate replicas, so the
 * fallback backend now arms its own timer; these cases pin the parser down and
 * prove a cron job actually fires in-process.
 */

const MINUTE = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe('cron parsing and next-fire calculation', () => {
  it('fires every minute at the next minute boundary', () => {
    const from = Date.parse('2026-01-01T00:00:30.000Z');
    expect(iso(nextCronFireMs('* * * * *', from))).toBe('2026-01-01T00:01:00.000Z');
  });

  it('honours step fields and stays aligned to the step grid', () => {
    const from = Date.parse('2026-01-01T00:07:30.000Z');
    expect(iso(nextCronFireMs('*/15 * * * *', from))).toBe('2026-01-01T00:15:00.000Z');
    // At an exact grid point the *next* one is returned, never "now".
    expect(iso(nextCronFireMs('*/15 * * * *', Date.parse('2026-01-01T00:15:00.000Z')))).toBe(
      '2026-01-01T00:30:00.000Z',
    );
  });

  it('rolls to the next day for a fixed daily time', () => {
    const from = Date.parse('2026-01-01T03:00:00.000Z');
    expect(iso(nextCronFireMs('0 3 * * *', from))).toBe('2026-01-02T03:00:00.000Z');
  });

  it('only fires on listed weekdays', () => {
    // 2026-01-03 is a Saturday; the next weekday match is Monday the 5th.
    const from = Date.parse('2026-01-03T12:00:00.000Z');
    expect(iso(nextCronFireMs('0 9 * * 1-5', from))).toBe('2026-01-05T09:00:00.000Z');
  });

  it('treats a restricted day-of-month and day-of-week as either-or (standard cron)', () => {
    const cron = parseCron('0 0 13 * 5');
    // 2026-02-13 is a Friday; 2026-03-13 is a Friday too but the 13th alone must match.
    expect(matchesCron(cron, new Date('2026-03-13T00:00:00.000Z'))).toBe(true);
    expect(matchesCron(cron, new Date('2026-03-06T00:00:00.000Z'))).toBe(true);
    expect(matchesCron(cron, new Date('2026-03-07T00:00:00.000Z'))).toBe(false);
  });

  it('rejects malformed and unsatisfiable expressions instead of guessing', () => {
    expect(() => parseCron('0 0 * *')).toThrow(CronParseError);
    expect(() => parseCron('60 * * * *')).toThrow(/超出范围/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/步长非法/);
    // February 30th never happens: failing loudly beats a timer that never fires.
    expect(() => nextCronFireMs('0 0 30 2 *', Date.now())).toThrow(/一年内不会触发/);
  });
});

describe('MemoryJobBackend cron scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a cron job in-process without Redis', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
    const backend = new MemoryJobBackend({ logger: { warn: () => undefined } });
    const runs: unknown[] = [];
    const jobs = createKernelJobContext('store', backend);
    jobs.handle('expiry-sweep', async (payload) => {
      runs.push(payload);
    });
    await jobs.schedule('expiry-sweep', { cron: '* * * * *' }, { stage: 1 });

    expect(runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runs).toEqual([{ stage: 1 }]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(runs).toHaveLength(2);
    await backend.stop();
  });

  it('warns once and stops when the expression is unusable', async () => {
    const warnings: string[] = [];
    const backend = new MemoryJobBackend({
      logger: { warn: (message: string) => void warnings.push(message) },
    });
    const jobs = createKernelJobContext('store', backend);
    jobs.handle('broken', async () => undefined);
    await jobs.schedule('broken', { cron: 'not a cron' });
    expect(warnings.join('\n')).toMatch(/cron 表达式不可用/);
    expect(warnings.join('\n')).toMatch(/已停止调度/);
  });

  it('never stacks a slow run: a tick during the previous run is skipped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const backend = new MemoryJobBackend({ logger: { warn: () => undefined } });
    let runs = 0;
    let release!: () => void;
    const jobs = createKernelJobContext('store', backend);
    jobs.handle('slow', async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await jobs.schedule('slow', { cron: '* * * * *' });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(runs).toBe(1);
    // Two more ticks while the first run is still pending: no pile-up.
    await vi.advanceTimersByTimeAsync(MINUTE * 2);
    expect(runs).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(runs).toBe(2);
    await backend.stop();
  });
});

describe('schedule diagnostics (/admin/jobs/schedules)', () => {
  it('reports cadence, next cron fire, and flags expressions that never fire', async () => {
    const runtime = getJobRuntime();
    const nowMs = Date.parse('2026-01-01T00:00:30.000Z');
    await runtime.schedule({ fullName: 'diag.every', schedule: { everyMs: 60_000 }, payload: null });
    await runtime.schedule({ fullName: 'diag.cron', schedule: { cron: '*/15 * * * *' }, payload: null });
    await runtime.schedule({ fullName: 'diag.broken', schedule: { cron: '0 0 30 2 *' }, payload: null });

    const { schedules } = describeSchedules(nowMs);
    const byName = new Map(schedules.map((entry) => [entry.name, entry]));
    expect(byName.get('diag.every')).toMatchObject({
      kind: 'everyMs',
      everyMs: 60_000,
      nextFireAt: null,
    });
    expect(byName.get('diag.cron')).toMatchObject({
      kind: 'cron',
      cron: '*/15 * * * *',
      nextFireAt: '2026-01-01T00:15:00.000Z',
    });
    // 一年内不会触发的表达式必须显式暴露，而不是安静地不跑。
    expect(byName.get('diag.broken')?.nextFireAt).toBeNull();
    expect(byName.get('diag.broken')?.error).toMatch(/一年内不会触发/);

    await runtime.removeByOwner('diag');
    expect(getJobRuntime().listSchedules().some((name) => name.startsWith('diag.'))).toBe(false);
  });
});
