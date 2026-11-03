import 'server-only';

/**
 * 进程级 TTL 缓存 —— 用于「每次页面渲染都要读、但很少变」的内核数据。
 *
 * 现场证据（线上 25,106 行 api 日志按 reqId 聚合）：
 *
 *   /themes/active          n=1111  p50=136ms  max=922ms
 *   /themes/atlas/frontend  n=540   p50=342ms  max=1004ms
 *   /plugins/frontends      n=379   p50=160ms  p95=8892ms  max=10025ms
 *   /catalog/categories     n=171   p50=228ms  max=1930ms
 *   /seo/meta               n=369   p50=55ms   max=668ms
 *
 * 首页 TTFB 冷启 1.37s / 1.67s，热 0.25~0.34s —— 差值几乎全是这些固定开销。
 * 单次都不算慢，问题是**每个请求都重买一遍**，而且是串行地买。
 *
 * 这个缓存只解决「相同答案被重复询问」；它不改变任何语义，也不缓存用户数据。
 */

interface Entry<T> {
  value: Promise<T>;
  expiresAt: number;
}

/**
 * 条目上限。超过就淘汰最旧的（Map 保持插入顺序，`keys().next()` 即最老）。
 *
 * 当前唯一的调用方用的是常量键（`PLUGIN_FRONTENDS_CACHE`），所以这个上限
 * 平时根本不会触发。但它是一道**结构性**防线：缓存键一旦掺进用户输入
 * （语言、主题 id、租户……），无界 Map 就是一个随流量缓慢增长的泄漏，
 * 而且没有任何告警 —— 只在 OOM 时才暴露。
 */
const MAX_ENTRIES = 500;

const store = new Map<string, Entry<unknown>>();

/** 清掉已经过期的条目；只在插入时调用，摊销成本可以忽略。 */
function sweepExpired(now: number): void {
  for (const [key, entry] of store) {
    if (now >= entry.expiresAt) store.delete(key);
  }
}

/** 插入新条目：先清过期，再按 LRU 顺序淘汰到上限以内。 */
function storeEntry(key: string, entry: Entry<unknown>, now: number): void {
  // 先删再插，让这个键移到 Map 末尾（插入顺序即最近使用顺序）。
  store.delete(key);
  store.set(key, entry);
  if (store.size <= MAX_ENTRIES) return;
  sweepExpired(now);
  // 清完过期还超限，说明确实是活跃键太多：丢掉最旧的。
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** 生成稳定的缓存键：对象按 key 排序序列化，避免字面量顺序影响命中。 */
export function cacheKey(scope: string, parts: unknown = null): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, stable(v)]),
      );
    }
    return value;
  };
  return parts === null ? scope : `${scope}:${JSON.stringify(stable(parts))}`;
}

export interface RememberOptions {
  /** 复用窗口。默认 10s。 */
  ttlMs?: number;
  /**
   * 缓存的是失败也会被保存，默认**不保存**：
   * 一次抖动不应该让所有请求在接下来整个 TTL 里都看到同一个错误。
   */
  cacheFailures?: boolean;
  /**
   * 绕过正在进行的请求，强制重新加载。
   *
   * 不用它也能靠 TTL 等到自然过期；但在「已知数据变了、要立即刷新」的场景
   * （插件启停）里等一个 30s 的 in-flight 是错的。
   */
  refresh?: boolean;
}

/**
 * 读取缓存，未命中则执行 `load`。
 *
 * 并发请求共享同一个 in-flight promise —— 冷启时 20 个并发请求只会打一次
 * 内核，而不是 20 次。这正是「首页冷启 1.37s」里最容易被放大的部分。
 */
export async function remember<T>(
  key: string,
  load: () => Promise<T>,
  options: RememberOptions = {},
): Promise<T> {
  const ttlMs = options.ttlMs ?? 10_000;
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (!options.refresh && hit && now < hit.expiresAt) return hit.value;

  const pending = load();
  const entry: Entry<T> = { value: pending, expiresAt: now + ttlMs };
  storeEntry(key, entry, now);
  if (options.cacheFailures !== true) {
    pending.catch(() => {
      // 只删自己：期间可能已经被更新的值替换。
      if (store.get(key) === entry) store.delete(key);
    });
  }
  return pending;
}

/** 让某个前缀下的缓存立即失效（插件/主题变更时用）。 */
export function invalidate(prefix: string): void {
  for (const key of [...store.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}:`)) store.delete(key);
  }
}

/** 清空全部（测试用）。 */
export function resetCache(): void {
  store.clear();
}

/** 当前缓存条目数（诊断用）。 */
export function cacheSize(): number {
  return store.size;
}
