/**
 * 平台信息的进程内缓存。
 *
 * `/platform/info` 是每个页面渲染都要打的公开端点，而它每次都要查一次
 * Setting 表 —— 一份几乎从不变化的数据被反复读。
 *
 * 这里断言的是**查询次数**与**失效语义**：
 *   - 读多次只查一次库（否则缓存等于没加）；
 *   - 写入后立刻读到新值（否则改完平台名要等缓存过期，属于用户可见的 bug）；
 *   - 缓存的是解析后的对象，坏数据仍然降级到默认值而不是把坏值缓存起来。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = new Map<string, unknown>();
const findUnique = vi.fn(async ({ where }: { where: { key: string } }) =>
  settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
);

vi.mock('../../src/plugins/prisma.ts', () => ({
  getPrisma: () => ({
    setting: {
      findUnique,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { key: string };
        create: { value: unknown };
        update: { value: unknown };
      }) => {
        settings.set(where.key, 'value' in create ? create.value : update.value);
        return { key: where.key };
      },
    },
  }),
}));

import {
  getPlatformInfo,
  invalidatePlatformInfo,
  setPlatformInfo,
  PLATFORM_INFO_SETTING_KEY,
} from '../../src/lib/platform-info.ts';

beforeEach(() => {
  settings.clear();
  findUnique.mockClear();
  // 缓存是模块级的，用例之间必须隔离，否则第二个用例会读到第一个用例的值。
  invalidatePlatformInfo();
});

describe('platform info caching', () => {
  it('reads the settings row once for repeated reads', async () => {
    settings.set(PLATFORM_INFO_SETTING_KEY, {
      name: 'Panel',
      description: 'desc',
      url: null,
      brandDisplay: 'both',
    });

    const first = await getPlatformInfo();
    const second = await getPlatformInfo();
    const third = await getPlatformInfo();

    expect(first.name).toBe('Panel');
    // 三次读取只查一次库。
    expect(findUnique).toHaveBeenCalledTimes(1);
    // 返回的是同一个对象（缓存的是解析结果，不是原始行）。
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('returns the new value immediately after a write', async () => {
    settings.set(PLATFORM_INFO_SETTING_KEY, {
      name: 'Old',
      description: 'desc',
      url: null,
      brandDisplay: 'both',
    });
    await getPlatformInfo();

    await setPlatformInfo(
      { name: 'New', description: 'desc', url: null, brandDisplay: 'both' },
      'admin-1',
    );

    // 改完立刻可见：否则后台保存后前台还是旧名字，属于用户可见的 bug。
    expect((await getPlatformInfo()).name).toBe('New');
  });

  it('invalidates on demand so a second process view can refresh', async () => {
    settings.set(PLATFORM_INFO_SETTING_KEY, {
      name: 'A',
      description: 'd',
      url: null,
      brandDisplay: 'both',
    });
    await getPlatformInfo();

    // 模拟另一副本改了库：本副本只有主动失效后才看得到。
    settings.set(PLATFORM_INFO_SETTING_KEY, {
      name: 'B',
      description: 'd',
      url: null,
      brandDisplay: 'both',
    });
    expect((await getPlatformInfo()).name).toBe('A');

    invalidatePlatformInfo();
    expect((await getPlatformInfo()).name).toBe('B');
  });

  it('falls back to defaults for a malformed row instead of caching garbage', async () => {
    settings.set(PLATFORM_INFO_SETTING_KEY, { name: '', description: '' });

    const info = await getPlatformInfo();
    expect(info.name).toBe('StackPanel');

    // 坏值不该被当成有效配置缓存下来。
    settings.set(PLATFORM_INFO_SETTING_KEY, {
      name: 'Good',
      description: 'd',
      url: null,
      brandDisplay: 'both',
    });
    invalidatePlatformInfo();
    expect((await getPlatformInfo()).name).toBe('Good');
  });
});

describe('cross-replica invalidation', () => {
  /**
   * 缓存是**进程内**的，而集群默认 2 副本（`docker-compose.cluster.yml`）。
   *
   * 真实故障形态：管理员在 A 副本改了平台名 → A 的 `cached` 被替换 → B 的
   * `cached` 仍是旧值，且**没有 TTL**，于是 B 会一直渲染旧名字直到进程重启。
   * 用户刷新页面时命中哪个副本决定了看到新名还是旧名。
   *
   * 修法是让配置变更走 `coherence` 的 Redis 广播（`kind: 'config'`），
   * 收到广播的副本调用 `invalidatePlatformInfo()`。这里模拟「另一副本改了库，
   * 本副本收到广播」的顺序。
   */
  it('re-reads the row after a broadcast invalidation', async () => {
    settings.set(PLATFORM_INFO_SETTING_KEY, {
      name: 'Before',
      description: 'desc',
      url: null,
      brandDisplay: 'both',
    });

    const first = await getPlatformInfo();
    expect(first.name).toBe('Before');
    expect(findUnique).toHaveBeenCalledTimes(1);

    // 另一副本写了新值（本副本的 cached 不知情）。
    settings.set(PLATFORM_INFO_SETTING_KEY, {
      name: 'After',
      description: 'desc',
      url: null,
      brandDisplay: 'both',
    });

    // 没有广播时，本副本仍读缓存 —— 这正是修复前的行为。
    const stale = await getPlatformInfo();
    expect(stale.name).toBe('Before');
    expect(findUnique).toHaveBeenCalledTimes(1);

    // 广播到达 → 丢弃缓存 → 下一次读取拿到新值。
    invalidatePlatformInfo();
    const fresh = await getPlatformInfo();
    expect(fresh.name).toBe('After');
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('keeps the cache warm across unrelated reads after invalidation', async () => {
    // 失效只该丢一次，不该退化成「每次读都查库」。
    settings.set(PLATFORM_INFO_SETTING_KEY, {
      name: 'Warm',
      description: 'desc',
      url: null,
      brandDisplay: 'both',
    });

    await getPlatformInfo();
    invalidatePlatformInfo();
    await getPlatformInfo();
    await getPlatformInfo();

    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
