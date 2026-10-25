import { describe, expect, it, vi } from 'vitest';
import {
  createStorageWatch,
  STORAGE_ALERT_AFTER_FAILURES,
  STORAGE_RECOVERY_AFTER_SUCCESSES,
} from '../../src/notifications/storage-watch.ts';

/**
 * 存储巡检告警（对标 #12.5 `ossExceptionNotice`）。
 *
 * 这里锁的是**告警时机**，不是「能不能发通知」：直接照抄对方「失败一次就通知」
 * 会让管理员被抖动训练成不看告警，所以断言的正是「连续失败才报、连续成功才说恢复」。
 */
function harness(overrides: {
  admins?: string[];
  listAdminsFails?: boolean;
  notifyFails?: boolean;
} = {}) {
  const created: Array<Record<string, unknown>> = [];
  const notifications = {
    create: vi.fn(async (input: Record<string, unknown>) => {
      if (overrides.notifyFails) throw new Error('notifications down');
      created.push(input);
      return { id: `n-${created.length}`, ...input };
    }),
  };
  const listAdminIds = vi.fn(async () => {
    if (overrides.listAdminsFails) throw new Error('db down');
    return overrides.admins ?? ['admin-1', 'admin-2'];
  });
  const logger = { warn: vi.fn(), info: vi.fn() };
  const ping = vi.fn(async () => true);
  const watch = createStorageWatch({
    ping,
    notifications: notifications as never,
    listAdminIds,
    logger,
  });
  return { watch, ping, created, listAdminIds, logger };
}

const types = (created: Array<Record<string, unknown>>) => created.map((row) => row.type);

describe('存储巡检告警', () => {
  it('连续失败到阈值才告警，且只发一次', async () => {
    const h = harness();
    h.ping.mockResolvedValue(false);

    for (let i = 0; i < STORAGE_ALERT_AFTER_FAILURES - 1; i += 1) await h.watch();
    // 抖动不告警：这是与对方「失败即通知」的关键差异。
    expect(h.created).toHaveLength(0);

    await h.watch();
    expect(types(h.created)).toEqual([
      'admin.storage.unreachable',
      'admin.storage.unreachable',
    ]);

    // 已经报过就不再刷屏，故障持续多久都只有那一条。
    await h.watch();
    await h.watch();
    expect(h.created).toHaveLength(2);
  });

  it('探测抛错按不可用处理，不会被当成可用', async () => {
    const h = harness();
    h.ping.mockRejectedValue(new Error('connect ETIMEDOUT'));

    for (let i = 0; i < STORAGE_ALERT_AFTER_FAILURES; i += 1) await h.watch();

    expect(types(h.created)).toContain('admin.storage.unreachable');
    expect(String(h.created[0]?.body)).toContain('ETIMEDOUT');
  });

  it('恢复要连续成功到阈值，且失败会重置计数', async () => {
    const h = harness();
    h.ping.mockResolvedValue(false);
    for (let i = 0; i < STORAGE_ALERT_AFTER_FAILURES; i += 1) await h.watch();
    h.created.length = 0;

    h.ping.mockResolvedValue(true);
    await h.watch();
    expect(h.created).toHaveLength(0);

    // 中间又抖了一次：连续成功计数必须归零，否则「恢复」会在故障中途发出。
    h.ping.mockResolvedValue(false);
    await h.watch();
    h.ping.mockResolvedValue(true);
    for (let i = 0; i < STORAGE_RECOVERY_AFTER_SUCCESSES - 1; i += 1) await h.watch();
    expect(h.created).toHaveLength(0);

    await h.watch();
    expect(types(h.created)).toEqual([
      'admin.storage.recovered',
      'admin.storage.recovered',
    ]);
  });

  it('通知失败不让任务抛错（否则任务会进死信并被反复重试）', async () => {
    const h = harness({ notifyFails: true });
    h.ping.mockResolvedValue(false);

    for (let i = 0; i < STORAGE_ALERT_AFTER_FAILURES; i += 1) {
      await expect(h.watch()).resolves.toBeUndefined();
    }
    expect(h.logger.warn).toHaveBeenCalled();
  });

  it('没有管理员或读不到管理员列表时只记日志，不抛错', async () => {
    const none = harness({ admins: [] });
    none.ping.mockResolvedValue(false);
    for (let i = 0; i < STORAGE_ALERT_AFTER_FAILURES; i += 1) await none.watch();
    expect(none.created).toHaveLength(0);
    expect(none.logger.warn).toHaveBeenCalled();

    const broken = harness({ listAdminsFails: true });
    broken.ping.mockResolvedValue(false);
    for (let i = 0; i < STORAGE_ALERT_AFTER_FAILURES; i += 1) {
      await expect(broken.watch()).resolves.toBeUndefined();
    }
    expect(broken.logger.warn).toHaveBeenCalled();
  });
});
