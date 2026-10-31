import { describe, expect, it } from 'vitest';
import type { JobContext, JobHandler, JobSchedule } from '@stackpanel/sdk';
import { registerMembershipJobs } from './index';

/**
 * `REF-定时任务与幂等契约.md` §3 的清单锁成断言。
 *
 * 注意这条任务**不是**内核的 `membership.sweep-expired`：前者清插件自己的会员授予，
 * 后者清内核限时权限组成员关系。两者不可合并，名字也不能撞。
 */
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

describe('store-product-membership job inventory matches the documented contract', () => {
  it('schedules the hourly sweep and registers its handler', () => {
    const { context, schedules, handlers } = fakeJobContext();
    registerMembershipJobs(context);

    expect(schedules).toEqual([{ name: 'membership-sweep', schedule: { everyMs: 60 * 60_000 } }]);
    expect(handlers.has('membership-sweep')).toBe(true);
  });

  it('uses a bare name so the kernel qualifies it under this plugin only', () => {
    const { context, schedules } = fakeJobContext();
    registerMembershipJobs(context);
    expect(schedules[0]?.name).toBe('membership-sweep');
    expect(schedules[0]?.name).not.toContain('.');
  });
});
