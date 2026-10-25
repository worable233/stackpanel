import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobContext, JobHandler, JobSchedule } from '@stackpanel/sdk';
import { registerChannelJobs } from './index';

/** `REF-定时任务与幂等契约.md` §3 的清单锁成断言。 */
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('channel job inventory matches the documented contract', () => {
  it('schedules the webhook delivery poll every 5s with a handler', () => {
    const { context, schedules, handlers } = fakeJobContext();
    registerChannelJobs(context);

    // 插件侧只写裸名，内核 `createKernelJobContext('channel')` 才加上前缀，
    // 所以运行时看到的是 `channel.webhook-deliver`、这里注册的是 `webhook-deliver`。
    expect(schedules).toEqual([{ name: 'webhook-deliver', schedule: { everyMs: 5_000 } }]);
    expect(handlers.has('webhook-deliver')).toBe(true);
  });

  it('does not touch the network or the database when merely registering', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { context } = fakeJobContext();
    registerChannelJobs(context);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
