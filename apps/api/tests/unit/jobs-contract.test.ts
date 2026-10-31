import { describe, expect, it, vi } from 'vitest';
import type { JobContext, JobHandler, JobSchedule } from '@stackpanel/sdk';
import { registerKernelSweeps } from '../../src/jobs/index.ts';
import { KERNEL_JOBS } from '../../src/jobs/kernel-jobs.ts';

/**
 * #12.5 的「我方半张表」不能只是文档：清单和频率一旦漂移，对标结论就失效了，
 * 而漂移不会有人主动发现。这里把 `REF-定时任务与幂等契约.md` §2 的数字变成断言 ——
 * 改名字或改频率都会红，逼着改的人同时去改文档。
 *
 * §3 的插件任务不在这里：它们的名字带插件前缀，由各自的插件套件覆盖
 * （`store` / `channel` / `store-product-membership`）。
 */

interface CapturedSchedule {
  name: string;
  schedule: JobSchedule;
}

function fakeJobContext() {
  const schedules: CapturedSchedule[] = [];
  const handlers = new Map<string, JobHandler>();
  const context = {
    schedule: async (name: string, schedule: JobSchedule) => {
      schedules.push({ name, schedule });
    },
    handle: (name: string, handler: JobHandler) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    enqueue: async () => '',
  } as unknown as JobContext;
  return { context, schedules, handlers };
}

function deps(overrides: Partial<Parameters<typeof registerKernelSweeps>[1]> = {}) {
  return {
    stateSweep: vi.fn(),
    paymentSweep: vi.fn(async () => undefined),
    outboxRelay: vi.fn(async () => undefined),
    outboxCleanup: vi.fn(async () => undefined),
    walletHoldSweep: vi.fn(async () => undefined),
    notificationDeliverySweep: vi.fn(async () => undefined),
    catalogRefresh: vi.fn(async () => undefined),
    autoUpdate: vi.fn(async () => undefined),
    membershipSweep: vi.fn(async () => undefined),
    storageWatch: vi.fn(async () => undefined),
    logger: { warn: vi.fn() },
    ...overrides,
  };
}

/** 与 `REF-定时任务与幂等契约.md` §2 的表格逐行对应的名字与频率（毫秒）。 */
const DOCUMENTED: Array<[string, number]> = [
  [KERNEL_JOBS.stateSweep, 60_000],
  [KERNEL_JOBS.paymentSweep, 5 * 60_000],
  [KERNEL_JOBS.walletHoldSweep, 60_000],
  [KERNEL_JOBS.outboxRelay, 2_000],
  [KERNEL_JOBS.notificationDeliverySweep, 30_000],
  [KERNEL_JOBS.catalogRefresh, 6 * 60 * 60_000],
  [KERNEL_JOBS.autoUpdate, 6 * 60 * 60_000],
  [KERNEL_JOBS.membershipSweep, 60 * 60_000],
  // 与对方 `ossExceptionNotice` 同频；告警阈值是「连续 3 次失败」，不靠频率防抖。
  [KERNEL_JOBS.storageWatch, 5 * 60_000],
];

describe('#12.5 kernel job inventory matches the documented contract', () => {
  it('schedules exactly the documented jobs at the documented cadence', async () => {
    const { context, schedules, handlers } = fakeJobContext();
    await registerKernelSweeps(context, deps());

    expect(schedules.map((entry) => entry.name).sort()).toEqual(
      DOCUMENTED.map(([name]) => name).sort(),
    );
    for (const [name, everyMs] of DOCUMENTED) {
      const entry = schedules.find((candidate) => candidate.name === name);
      expect(entry?.schedule, `schedule for ${name}`).toEqual({ everyMs });
      // 每个排期都必须有处理器，否则 BullMQ 会拿没处理器的任务空转到预算耗尽。
      expect(handlers.has(name), `handler for ${name}`).toBe(true);
    }
  });

  it('drops the optional jobs entirely when their deps are absent (zero egress)', async () => {
    const { context, schedules, handlers } = fakeJobContext();
    await registerKernelSweeps(context, {
      stateSweep: vi.fn(),
      paymentSweep: vi.fn(async () => undefined),
      outboxRelay: vi.fn(async () => undefined),
      outboxCleanup: vi.fn(async () => undefined),
      walletHoldSweep: vi.fn(async () => undefined),
      notificationDeliverySweep: vi.fn(async () => undefined),
      logger: { warn: vi.fn() },
    });

    expect(schedules.map((entry) => entry.name).sort()).toEqual(
      [
        KERNEL_JOBS.stateSweep,
        KERNEL_JOBS.paymentSweep,
        KERNEL_JOBS.walletHoldSweep,
        KERNEL_JOBS.outboxRelay,
        KERNEL_JOBS.notificationDeliverySweep,
      ].sort(),
    );
    // 目录源被关闭的实例不注册处理器：不是「注册了但空跑」，是没有这一项。
    for (const name of [
      KERNEL_JOBS.catalogRefresh,
      KERNEL_JOBS.autoUpdate,
      KERNEL_JOBS.membershipSweep,
      KERNEL_JOBS.storageWatch,
    ]) {
      expect(handlers.has(name), `handler for ${name}`).toBe(false);
    }
  });

  it('runs outbox cleanup roughly hourly on the relay cadence, not every pass', async () => {
    const sweep = deps();
    const { context, handlers } = fakeJobContext();
    await registerKernelSweeps(context, sweep);
    const relay = handlers.get(KERNEL_JOBS.outboxRelay);
    if (!relay) throw new Error('outbox relay handler missing');

    // relay 每 2s 一次，清理每 1800 次触发一次 ≈ 1 小时。
    const passes = Math.round((60 * 60_000) / 2_000);
    for (let index = 0; index < passes - 1; index += 1) await relay({} as never);
    expect(sweep.outboxCleanup).not.toHaveBeenCalled();
    await relay({} as never);
    expect(sweep.outboxCleanup).toHaveBeenCalledTimes(1);
  });

  it('does not let an outbox cleanup failure kill the relay (warn and continue)', async () => {
    const sweep = deps({
      outboxCleanup: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const { context, handlers } = fakeJobContext();
    await registerKernelSweeps(context, sweep);
    const relay = handlers.get(KERNEL_JOBS.outboxRelay);
    if (!relay) throw new Error('outbox relay handler missing');

    const passes = Math.round((60 * 60_000) / 2_000);
    for (let index = 0; index < passes; index += 1) await relay({} as never);
    expect(sweep.outboxCleanup).toHaveBeenCalledTimes(1);
    expect(sweep.logger.warn).toHaveBeenCalledWith(expect.stringContaining('outbox cleanup failed'));
    // 清理失败不影响转发本身：转发被调用了 1800 次。
    expect((sweep.outboxRelay as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(
      passes,
    );
  });
});
