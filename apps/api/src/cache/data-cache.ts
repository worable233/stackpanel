/**
 * 内核托管读缓存（ADR-0022 D3 / PLAN-perf-hardening P10–P12）。
 *
 * 为什么必须由内核托管：在集群里插件无法正确失效其他副本的内存，也无权广播。
 * 若放任插件自建进程内缓存，就出现了一条绕过内核的第二套数据通道——正是
 * ADR-0001「一份数据源、一套契约」与 ADR-0021「禁止特权通道」要禁止的东西。
 * 所以内核给机制（存储、有界、跨副本失效），插件只声明依赖。
 *
 * 失效是声明式的，且**不挂在** `sp:runtime:invalidate` 上：那条通道会
 * `runtime.unregister()` 并重载插件（coherence.ts 的 reloadUnlocked），与
 * 「某些数据变了」是完全不同的事。这里用独立频道 `sp:cache:invalidate`。
 *
 * 三层边界，缺一不可：
 * 1. 有界：条目数与总字节都有上限，LRU 逐出（内存不能是攻击面）。
 * 2. 可失效：写入该 kind 的**非 volatile 字段**即失效（本地 + 广播）。
 * 3. 有陈旧上界：TTL 有硬上限，广播丢失最多只服务这么久。
 *
 * 只用于读多写少的配置类数据。余额、额度、限流、会话等一致性敏感状态一律
 * 继续走 `ctx.state` 与内核服务（ADR-0017 §2「跨请求状态一律外置」）。
 */

import { randomUUID } from 'node:crypto';
import type { CacheReadOptions } from '@stackpanel/sdk';
import { REDIS_KEY_PREFIX } from '@stackpanel/sdk';

/** 缓存失效广播的频道名。 */
export function cacheInvalidateChannel(): string {
  return `${REDIS_KEY_PREFIX.cache}invalidate`;
}

/** 缓存数据键前缀（`sp:cache:`，ADR-0017 §8 预留、此前无人使用）。 */
export function cacheDataPrefix(): string {
  return REDIS_KEY_PREFIX.cache;
}

interface RedisLike {
  publish(channel: string, message: string): Promise<unknown>;
  duplicate(): RedisLike;
  subscribe(channel: string): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  disconnect?(): void;
  quit?(): Promise<unknown>;
}

export interface DataCacheLogger {
  warn(message: string): void;
  info?(message: string): void;
}

export interface DataCacheOptions {
  /** 最多保留多少条目。 */
  maxEntries?: number;
  /** 最多占多少字节（按序列化长度估算）。 */
  maxBytes?: number;
  /** 单条 TTL 的硬上限：调用方给的 TTL 只会被调小。 */
  maxTtlMs?: number;
  /** 有 Redis 时启用跨副本失效广播；否则退化为进程内缓存。 */
  redis?: RedisLike | null;
  logger?: DataCacheLogger;
}

/** 默认上限：与容器内存预算同量级的保守值。 */
export const DEFAULT_CACHE_MAX_ENTRIES = 2_000;
export const DEFAULT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_CACHE_MAX_TTL_MS = 60_000;

interface CacheEntry {
  value: unknown;
  bytes: number;
  expiresAt: number;
  kinds: readonly string[];
}

/**
 * 进程内、有界、可跨副本失效的读缓存。
 *
 * 不做序列化往返：值在进程内按引用保存，只在**写出**到别的副本时不存在
 * （本实现不共享值，只共享失效信号——这样也避免了把大对象塞进 Redis）。
 */
export class DataCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly byKind = new Map<string, Set<string>>();
  /** 每个 kind 的失效代号：用于丢弃「读了旧数据、失效之后才落地」的条目。 */
  private readonly epochs = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly origin = randomUUID().slice(0, 8);
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxTtlMs: number;
  private redis: RedisLike | null;
  private readonly logger: DataCacheLogger | undefined;
  private subscriber: RedisLike | null = null;
  private subscriberListener: ((...args: unknown[]) => void) | null = null;
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private invalidations = 0;

  constructor(options: DataCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES;
    this.maxTtlMs = options.maxTtlMs ?? DEFAULT_CACHE_MAX_TTL_MS;
    this.redis = options.redis ?? null;
    this.logger = options.logger;
  }

  /** 迟到接线 Redis（`buildApp()` 是同步的，Redis 在 `initInfra()` 才连上）。 */
  attachRedis(redis: RedisLike): void {
    this.redis = redis;
  }

  /** 订阅跨副本失效广播（幂等）。无 Redis 时是 no-op。 */
  async start(): Promise<void> {
    if (!this.redis || this.subscriber) return;
    try {
      const subscriber = this.redis.duplicate();
      const listener = (...args: unknown[]): void => {
        const [, payload] = args as [string, string];
        this.onRemoteInvalidate(payload);
      };
      subscriber.on('message', listener);
      await subscriber.subscribe(cacheInvalidateChannel());
      this.subscriber = subscriber;
      this.subscriberListener = listener;
    } catch (error) {
      // 广播不可用时仍要工作：TTL 是有界的陈旧窗口，功能正确性不受影响。
      this.logger?.warn(`[cache] 失效广播订阅失败，退化为仅 TTL 失效：${String(error)}`);
    }
  }

  /** 停止订阅（关停/测试）。 */
  stop(): void {
    const subscriber = this.subscriber;
    if (!subscriber) return;
    this.subscriber = null;
    try {
      if (this.subscriberListener) subscriber.removeListener?.('message', this.subscriberListener);
      this.subscriberListener = null;
      void subscriber.quit?.().catch(() => undefined);
    } catch {
      /* 关停路径，忽略 */
    }
  }

  /** 记录一份值派生自哪些 kind（不含 loader，供跨进程代理复用）。 */
  async remember<T>(key: string, options: CacheReadOptions, loader: () => Promise<T>): Promise<T> {
    const existing = this.peek(key);
    if (existing.hit) return existing.value as T; // peek 已计入 hits

    // 防击穿：同一 key 的并发回源只跑一次。
    const already = this.inflight.get(key);
    if (already) return already as Promise<T>;

    const epochAtStart = this.currentEpochs(options.kinds);
    const promise = (async () => {
      const value = await loader();
      this.store(key, value, options, epochAtStart);
      return value;
    })();
    this.inflight.set(key, promise);
    try {
      return (await promise) as T;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 只读查询：命中返回 {hit:true}，未命中返回 {hit:false}（不触发回源）。 */
  peek(key: string): { hit: true; value: unknown } | { hit: false } {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return { hit: false };
    }
    if (entry.expiresAt <= Date.now()) {
      this.dropKey(key);
      this.misses += 1;
      return { hit: false };
    }
    // LRU：命中即刷新顺序。
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return { hit: true, value: entry.value };
  }

  /** 写入一份值（供跨进程代理使用；本地 remember 走 store）。 */
  put(key: string, value: unknown, options: CacheReadOptions): void {
    this.store(key, value, options, this.currentEpochs(options.kinds));
  }

  /** 仅本地失效 + 广播，不承诺等到所有副本确认（best-effort + TTL 兜底）。 */
  async invalidateKinds(kinds: readonly string[]): Promise<void> {
    if (kinds.length === 0) return;
    for (const kind of kinds) this.evictKindLocal(kind);
    this.invalidations += 1;
    if (!this.redis) return;
    const message = JSON.stringify({ origin: this.origin, kinds });
    try {
      await this.redis.publish(cacheInvalidateChannel(), message);
    } catch (error) {
      this.logger?.warn(`[cache] 失效广播发送失败：${String(error)}`);
    }
  }

  /** 立即丢弃所有派生自该 kind 的条目（本地）。 */
  evictKindLocal(kind: string): void {
    this.bumpEpoch(kind);
    const keys = this.byKind.get(kind);
    if (!keys) return;
    for (const key of [...keys]) this.dropKey(key);
  }

  /** 丢弃所有条目（测试/插件卸载）。 */
  clear(): void {
    for (const key of [...this.entries.keys()]) this.dropKey(key);
    this.inflight.clear();
  }

  stats(): {
    entries: number;
    bytes: number;
    hits: number;
    misses: number;
    evictions: number;
    invalidations: number;
    kinds: number;
  } {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      invalidations: this.invalidations,
      kinds: this.byKind.size,
    };
  }

  // --- internals -----------------------------------------------------------

  private store(key: string, value: unknown, options: CacheReadOptions, epochAtStart: Map<string, number>): void {
    const kinds = options.kinds ?? [];
    // 回源期间有写入落到这些 kind 上：结果已经是陈旧的，不能缓存（但仍返回给调用方，
    // 因为它就是本次请求读到的真实值）。
    for (const kind of kinds) {
      if ((this.epochs.get(kind) ?? 0) !== (epochAtStart.get(kind) ?? 0)) return;
    }
    const ttlMs = this.clampTtl(options.ttlMs);
    if (ttlMs <= 0) return;
    const bytes = estimateBytes(value);
    if (bytes > this.maxBytes) return;
    this.dropKey(key);
    this.entries.set(key, { value, bytes, expiresAt: Date.now() + ttlMs, kinds });
    this.bytes += bytes;
    for (const kind of kinds) {
      const set = this.byKind.get(kind) ?? new Set<string>();
      set.add(key);
      this.byKind.set(kind, set);
    }
    this.enforceBounds();
  }

  private clampTtl(ttlMs: number | undefined): number {
    const requested = ttlMs ?? this.maxTtlMs;
    if (!Number.isFinite(requested) || requested <= 0) return 0;
    return Math.min(requested, this.maxTtlMs);
  }

  private currentEpochs(kinds: readonly string[]): Map<string, number> {
    const snapshot = new Map<string, number>();
    for (const kind of kinds) snapshot.set(kind, this.epochs.get(kind) ?? 0);
    return snapshot;
  }

  private bumpEpoch(kind: string): void {
    this.epochs.set(kind, (this.epochs.get(kind) ?? 0) + 1);
  }

  private dropKey(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    for (const kind of entry.kinds) {
      const set = this.byKind.get(kind);
      if (!set) continue;
      set.delete(key);
      if (set.size === 0) this.byKind.delete(kind);
    }
  }

  private enforceBounds(): void {
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.dropKey(oldest.value);
      this.evictions += 1;
    }
  }

  private onRemoteInvalidate(raw: unknown): void {
    try {
      const parsed = JSON.parse(String(raw)) as { origin?: string; kinds?: unknown };
      if (parsed.origin === this.origin) return;
      if (!Array.isArray(parsed.kinds)) return;
      for (const kind of parsed.kinds) {
        if (typeof kind === 'string') this.evictKindLocal(kind);
      }
    } catch {
      /* 坏消息忽略：TTL 仍是有界兜底 */
    }
  }
}

/** 按序列化长度估算条目的内存占用（够用来做逐出判断，不做精确记账）。 */
function estimateBytes(value: unknown): number {
  if (value === null || value === undefined) return 8;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 64 : serialized.length + 64;
  } catch {
    // 不可序列化的值不进缓存（跨副本语义不明），给一个大数使其被拒。
    return Number.MAX_SAFE_INTEGER;
  }
}
