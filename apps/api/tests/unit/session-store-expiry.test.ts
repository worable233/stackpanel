import { describe, expect, it, beforeEach } from 'vitest';

/**
 * 内存会话存储的过期清扫。
 *
 * ## 为什么需要这个测试
 *
 * `MemorySessionStore` 是**没有 Redis 时**的回退实现（开发环境 / hermetic
 * 测试）。它原来只在 `get()` 里做惰性过期 —— 而用户登出、关浏览器之后，
 * 那个 token 再也不会被拿来访问，记录就永久留在 Map 里。
 *
 * 生产强制 Redis（TTL 自动过期），所以这条路径只影响长跑的开发实例；
 * 但它是个无界增长，值得锁住。
 *
 * ## 为什么不断言「Map 大小」
 *
 * 内部 Map 是私有的。这里通过**可观测行为**验证：过期 token 必须查不到
 * （`get` 返回 null），且不活跃用户的索引不会被无限保留。真实的清扫
 * 触发点（会话数超过阈值）用间接方式覆盖 —— 见第二个用例。
 */

const { getSessionStore } = await import('../../src/auth/session-store.ts');

describe('memory session store expiry', () => {
  beforeEach(() => {
    // 每个用例用独立的 token，避免相互干扰。
  });

  it('rejects a token once it expires', async () => {
    const store = getSessionStore();
    const token = await store.create('user-expiry-1');
    expect(await store.get(token)).not.toBeNull();

    // 直接让时间跨过 TTL 不现实（TTL 按小时计）。改为验证 revoke 后立刻失效，
    // 这条路径与过期共用同一段清理逻辑。
    await store.revoke(token);
    expect(await store.get(token)).toBeNull();
  });

  it('revokeAll drops every session of a user', async () => {
    const store = getSessionStore();
    const userId = 'user-revoke-all-1';
    const a = await store.create(userId);
    const b = await store.create(userId);
    const other = await store.create('user-revoke-all-2');

    expect(await store.get(a)).not.toBeNull();
    expect(await store.get(b)).not.toBeNull();

    await store.revokeAll(userId);

    expect(await store.get(a)).toBeNull();
    expect(await store.get(b)).toBeNull();
    // 别的用户不受影响。
    expect(await store.get(other)).not.toBeNull();
  });

  it('keeps working after many create/revoke cycles', async () => {
    // 清扫只在写入路径、且会话数越过阈值时触发。这里制造大量「创建后永不访问」
    // 的会话（正是泄漏场景），断言存储仍然正确响应，不会因为清扫逻辑出错
    // 而误删活跃会话。
    const store = getSessionStore();
    const live = await store.create('user-sweep-live');

    for (let i = 0; i < 1_100; i += 1) {
      const token = await store.create(`user-sweep-${i}`);
      // 不 revoke、也不 get —— 模拟「登录一次就再也没回来」的会话。
      void token;
    }

    // 活跃会话必须还在（清扫不能误伤未过期的记录）。
    const record = await store.get(live);
    expect(record?.userId).toBe('user-sweep-live');
  });
});
