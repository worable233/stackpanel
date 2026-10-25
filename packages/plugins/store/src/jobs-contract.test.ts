import { describe, expect, it } from 'vitest';
import type { JobContext, JobHandler, JobSchedule } from '@stackpanel/sdk';
import { registerStoreJobs } from './index';

/**
 * ``REF-定时任务与幂等契约.md`` §3 的清单同样不能靠「文档写着」来维持：
 * 频率一改（比如把履约轮询从 5 秒调成 1 秒）对齐结论就变了，而没人会主动回来改文档。
 */
const DOCUMENTED: Array<[string, number]> = [
  ['fulfillment-poll', 5_000],
  ['expiry-sweep', 60 * 60_000],
  ['order-purge', 6 * 60 * 60_000],
];

function fakeJobContext() {
  const schedules: Array<{ name: string; schedule: JobSchedule }> = [];
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

describe('store job inventory matches the documented contract', () => {
  it('schedules exactly the documented jobs at the documented cadence', () => {
    const { context, schedules, handlers } = fakeJobContext();
    registerStoreJobs(context);

    expect(schedules.map((entry) => entry.name).sort()).toEqual(
      DOCUMENTED.map(([name]) => name).sort(),
    );
    for (const [name, everyMs] of DOCUMENTED) {
      expect(schedules.find((entry) => entry.name === name)?.schedule, name).toEqual({ everyMs });
      expect(handlers.has(name), `handler for ${name}`).toBe(true);
    }
  });

  it('keeps every task inside the plugin namespace (no cross-plugin collisions)', () => {
    const { context, schedules } = fakeJobContext();
    registerStoreJobs(context);
    for (const { name } of schedules) {
      // 内核按 `<owner>.<name>` 限定；插件侧只写裸名，不能自带前缀或点号。
      expect(name).not.toContain('.');
    }
  });
});
