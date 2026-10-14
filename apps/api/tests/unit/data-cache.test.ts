import { describe, expect, it, vi } from 'vitest';
import { DataCache, cacheInvalidateChannel } from '../../src/cache/data-cache.ts';

/** 一个极小的假 Redis：记录广播，允许把消息投递给另一个订阅者。 */
function fakeRedis() {
  const published: Array<{ channel: string; message: string }> = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const client = {
    published,
    deliver(channel: string, message: string) {
      for (const listener of listeners.get(channel) ?? []) listener(channel, message);
    },
    publish: vi.fn(async (channel: string, message: string) => {
      published.push({ channel, message });
      return 1;
    }),
    duplicate() {
      return { ...client, publish: client.publish } as unknown as typeof client;
    },
    subscribe: vi.fn(async (channel: string) => {
      if (!listeners.has(channel)) listeners.set(channel, []);
      return 1;
    }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const channel = cacheInvalidateChannel();
      if (event === 'message') {
        if (!listeners.has(channel)) listeners.set(channel, []);
        listeners.get(channel)!.push(listener);
      }
      return client;
    }),
    removeListener: vi.fn(),
    quit: vi.fn(async () => 'OK'),
  };
  return client;
}

describe('DataCache', () => {
  it('returns the cached value and skips the loader on a hit', async () => {
    const cache = new DataCache();
    const loader = vi.fn(async () => ({ value: 1 }));
    const first = await cache.remember('k', { ttlMs: 1000, kinds: ['demo/a'] }, loader);
    const second = await cache.remember('k', { ttlMs: 1000, kinds: ['demo/a'] }, loader);
    expect(first).toEqual({ value: 1 });
    expect(second).toEqual({ value: 1 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats().hits).toBe(1);
  });

  it('collapses concurrent misses for one key into a single load', async () => {
    const cache = new DataCache();
    let resolve: ((value: string) => void) | undefined;
    const loader = vi.fn(
      () => new Promise<string>((r) => { resolve = r; }),
    );
    const a = cache.remember('k', { ttlMs: 1000, kinds: ['demo/a'] }, loader);
    const b = cache.remember('k', { ttlMs: 1000, kinds: ['demo/a'] }, loader);
    resolve?.('loaded');
    expect(await a).toBe('loaded');
    expect(await b).toBe('loaded');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('never stores a value loaded before an invalidation landed', async () => {
    const cache = new DataCache();
    let resolve: ((value: string) => void) | undefined;
    const pending = cache.remember('k', { ttlMs: 1000, kinds: ['demo/a'] }, () => new Promise<string>((r) => { resolve = r; }));
    // 失效发生在回源完成之前：结果已陈旧，不能再进缓存。
    await cache.invalidateKinds(['demo/a']);
    resolve?.('stale');
    expect(await pending).toBe('stale');
    expect(cache.stats().entries).toBe(0);
    // 下一次读必须重新回源。
    const loader = vi.fn(async () => 'fresh');
    expect(await cache.remember('k', { ttlMs: 1000, kinds: ['demo/a'] }, loader)).toBe('fresh');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('drops entries of an invalidated kind but keeps unrelated kinds', async () => {
    const cache = new DataCache();
    await cache.remember('a', { ttlMs: 1000, kinds: ['demo/a'] }, async () => 'A');
    await cache.remember('b', { ttlMs: 1000, kinds: ['demo/b'] }, async () => 'B');
    await cache.invalidateKinds(['demo/a']);
    const aLoader = vi.fn(async () => 'A2');
    const bLoader = vi.fn(async () => 'B2');
    expect(await cache.remember('a', { ttlMs: 1000, kinds: ['demo/a'] }, aLoader)).toBe('A2');
    expect(await cache.remember('b', { ttlMs: 1000, kinds: ['demo/b'] }, bLoader)).toBe('B');
    expect(aLoader).toHaveBeenCalledTimes(1);
    expect(bLoader).not.toHaveBeenCalled();
  });

  it('caps a requested ttl at the configured maximum', async () => {
    const cache = new DataCache({ maxTtlMs: 10 });
    await cache.remember('k', { ttlMs: 60_000, kinds: ['demo/a'] }, async () => 'v');
    await new Promise((r) => setTimeout(r, 20));
    const loader = vi.fn(async () => 'v2');
    expect(await cache.remember('k', { ttlMs: 60_000, kinds: ['demo/a'] }, loader)).toBe('v2');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('evicts least-recently-used entries past the entry bound', async () => {
    const cache = new DataCache({ maxEntries: 2 });
    const load = (value: string) => async () => value;
    await cache.remember('a', { ttlMs: 1000, kinds: ['demo/a'] }, load('A'));
    await cache.remember('b', { ttlMs: 1000, kinds: ['demo/a'] }, load('B'));
    // 触碰 a，使其成为最近使用；插入 c 应逐出 b。
    await cache.remember('a', { ttlMs: 1000, kinds: ['demo/a'] }, load('A2'));
    await cache.remember('c', { ttlMs: 1000, kinds: ['demo/a'] }, load('C'));
    const bLoader = vi.fn(async () => 'B2');
    expect(await cache.remember('b', { ttlMs: 1000, kinds: ['demo/a'] }, bLoader)).toBe('B2');
    expect(bLoader).toHaveBeenCalledTimes(1);
    expect(cache.stats().evictions).toBeGreaterThan(0);
    expect(cache.stats().entries).toBeLessThanOrEqual(2);
  });

  it('refuses values larger than the byte budget', async () => {
    const cache = new DataCache({ maxBytes: 64 });
    await cache.remember('big', { ttlMs: 1000, kinds: ['demo/a'] }, async () => 'x'.repeat(500));
    expect(cache.stats().entries).toBe(0);
  });

  it('propagates invalidation to other replicas through the channel', async () => {
    const redis = fakeRedis();
    const one = new DataCache({ redis });
    const two = new DataCache({ redis });
    await one.start();
    await two.start();
    const twoLoader = vi.fn(async () => 'from-two');
    await two.remember('k', { ttlMs: 1000, kinds: ['demo/a'] }, twoLoader);
    // one 失效 → 广播 → two 的订阅者丢弃条目。
    await one.invalidateKinds(['demo/a']);
    expect(redis.publish).toHaveBeenCalledTimes(1);
    redis.deliver(cacheInvalidateChannel(), redis.published[0]!.message);
    expect(await two.remember('k', { ttlMs: 1000, kinds: ['demo/a'] }, twoLoader)).toBe('from-two');
    expect(twoLoader).toHaveBeenCalledTimes(2);
  });

  it('ignores its own broadcast', async () => {
    const redis = fakeRedis();
    const cache = new DataCache({ redis });
    await cache.start();
    await cache.remember('k', { ttlMs: 1000, kinds: ['demo/a'] }, async () => 'v');
    await cache.invalidateKinds(['demo/a']);
    // 把同一条消息投递回自己：不能因此再次清空（它已经清过，且 origin 相同应忽略）。
    await cache.remember('k', { ttlMs: 1000, kinds: ['demo/a'] }, async () => 'v2');
    redis.deliver(cacheInvalidateChannel(), redis.published[0]!.message);
    const loader = vi.fn(async () => 'v3');
    expect(await cache.remember('k', { ttlMs: 1000, kinds: ['demo/a'] }, loader)).toBe('v2');
    expect(loader).not.toHaveBeenCalled();
  });
});

describe('dispatchCacheCapability（isolated 桥接）', () => {
  it('peek → put → peek hits, and invalidate clears', async () => {
    const { resetDataCache, dispatchCacheCapability } = await import('../../src/cache/index.ts');
    resetDataCache();
    expect(dispatchCacheCapability('cache.peek', { key: 'bridge' })).toEqual({ hit: false });
    dispatchCacheCapability('cache.put', { key: 'bridge', value: { n: 1 }, ttlMs: 1000, kinds: ['demo/a'] });
    expect(dispatchCacheCapability('cache.peek', { key: 'bridge' })).toEqual({ hit: true, value: { n: 1 } });
    dispatchCacheCapability('cache.invalidate', { kinds: ['demo/a'] });
    expect(dispatchCacheCapability('cache.peek', { key: 'bridge' })).toEqual({ hit: false });
    resetDataCache();
  });

  it('rejects unknown capabilities instead of silently no-oping', async () => {
    const { dispatchCacheCapability } = await import('../../src/cache/index.ts');
    expect(() => dispatchCacheCapability('cache.evictEverything', {})).toThrow(/未知缓存能力/);
  });
});
