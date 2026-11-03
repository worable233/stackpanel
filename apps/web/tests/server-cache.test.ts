import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey, cacheSize, invalidate, remember, resetCache } from '@/lib/server-cache';

/**
 * 「每次页面渲染重复询问同一个答案」的缓存。
 *
 * 现场数值（线上 api 日志按 reqId 聚合）：/themes/active 1111 次、
 * /plugins/frontends 379 次（p95 8892ms）、/themes/atlas/frontend 540 次。
 * 单次都不算慢，问题是每个请求都重买一遍。首页 TTFB 冷启 1.37s、热 0.25s，
 * 差值几乎全是这些固定开销。
 *
 * 这里断言的是缓存的**语义**，不是「调了几次」：失败不缓存、并发合并、
 * 失效按前缀 —— 每一条错了都会表现成生产上的「偶发不一致」。
 */

beforeEach(() => resetCache());

describe('remember', () => {
  it('serves a repeated read from the cached value', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return { plugins: [] };
    };
    await remember('k', load);
    await remember('k', load);
    expect(calls).toBe(1);
  });

  it('coalesces concurrent misses into one call', async () => {
    // 冷启时 20 个并发请求不该打 20 次内核。
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = async () => {
      calls += 1;
      await gate;
      return 'value';
    };
    const all = Promise.all([remember('k', load), remember('k', load), remember('k', load)]);
    release();
    await expect(all).resolves.toEqual(['value', 'value', 'value']);
    expect(calls).toBe(1);
  });

  it('does not cache a failure', async () => {
    // 一次抖动不能让接下来整个 TTL 的所有请求都看到同一个错误。
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'recovered';
    };
    await expect(remember('k', load)).rejects.toThrow('boom');
    await expect(remember('k', load)).resolves.toBe('recovered');
    expect(calls).toBe(2);
  });

  it('does not let a stale in-flight failure evict a newer value', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failing = remember('k', async () => {
      await gate;
      throw new Error('late');
    });
    // 用新值覆盖同一个键，再让旧的失败收尾。
    await remember('k', async () => 'fresh', { ttlMs: 60_000, refresh: true });
    release();
    await expect(failing).rejects.toThrow('late');
    await expect(remember('k', async () => 'should-not-run')).resolves.toBe('fresh');
  });

  it('respects the TTL', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const load = async () => {
        calls += 1;
        return calls;
      };
      await remember('k', load, { ttlMs: 1_000 });
      vi.advanceTimersByTime(500);
      await remember('k', load, { ttlMs: 1_000 });
      expect(calls).toBe(1);
      vi.advanceTimersByTime(600);
      await remember('k', load, { ttlMs: 1_000 });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cacheKey', () => {
  it('is order-independent for object keys', () => {
    // 否则字面量顺序稍有不同就会静默变成未命中。
    expect(cacheKey('s', { a: 1, b: 2 })).toBe(cacheKey('s', { b: 2, a: 1 }));
  });

  it('distinguishes different values', () => {
    expect(cacheKey('s', { a: 1 })).not.toBe(cacheKey('s', { a: 2 }));
  });

  it('ignores undefined members so they do not fragment the cache', () => {
    expect(cacheKey('s', { a: 1, b: undefined })).toBe(cacheKey('s', { a: 1 }));
  });

  it('handles nested arrays and objects', () => {
    expect(cacheKey('s', { list: [{ b: 1, a: 2 }] })).toBe(cacheKey('s', { list: [{ a: 2, b: 1 }] }));
  });
});

describe('invalidate', () => {
  it('drops the prefix and its children but nothing else', async () => {
    let a = 0;
    let b = 0;
    let other = 0;
    await remember('plugin-frontends', async () => (a += 1));
    await remember('plugin-frontends:x', async () => (b += 1));
    await remember('theme', async () => (other += 1));
    invalidate('plugin-frontends');
    await remember('plugin-frontends', async () => (a += 1));
    await remember('plugin-frontends:x', async () => (b += 1));
    await remember('theme', async () => (other += 1));
    expect(a).toBe(2);
    expect(b).toBe(2);
    // 不相干的作用域不受影响。
    expect(other).toBe(1);
  });

  it('does not treat a longer sibling prefix as a child', async () => {
    let calls = 0;
    await remember('plugin-frontends-extra', async () => (calls += 1));
    invalidate('plugin-frontends');
    await remember('plugin-frontends-extra', async () => (calls += 1));
    expect(calls).toBe(1);
  });
});

describe('bounded growth', () => {
  it('never lets the store grow past its cap', async () => {
    // 无界 Map 的隐患：缓存键一旦掺进用户输入（语言、主题 id、租户……），
    // 条目数会随流量单调增长，且没有任何告警 —— 只在 OOM 时才暴露。
    // 这里塞远超上限的键，断言 size 被压住。
    for (let i = 0; i < 1200; i += 1) {
      await remember(`flood:${i}`, async () => i, { ttlMs: 60_000 });
    }
    expect(cacheSize()).toBeLessThanOrEqual(500);
  });

  it('drops expired entries before evicting live ones', async () => {
    // 过期条目应该先被清掉，而不是把还有效的键挤出去。
    await remember('live', async () => 'keep-me', { ttlMs: 60_000 });
    // 塞一批立刻过期的键，把它们挤到 Map 里。
    for (let i = 0; i < 600; i += 1) {
      await remember(`gone:${i}`, async () => i, { ttlMs: 0 });
    }
    // 有效键仍应命中（没有重新执行 loader）。
    let reloaded = 0;
    const value = await remember('live', async () => {
      reloaded += 1;
      return 'reloaded';
    }, { ttlMs: 60_000 });
    expect(value).toBe('keep-me');
    expect(reloaded).toBe(0);
  });

  it('keeps the most recent key when evicting', async () => {
    // 淘汰必须按插入顺序（最旧先走），否则刚写进去的值会立刻被自己挤掉。
    for (let i = 0; i < 600; i += 1) {
      await remember(`seq:${i}`, async () => i, { ttlMs: 60_000 });
    }
    let reloaded = 0;
    const value = await remember('seq:599', async () => {
      reloaded += 1;
      return -1;
    }, { ttlMs: 60_000 });
    expect(value).toBe(599);
    expect(reloaded).toBe(0);
  });
});
