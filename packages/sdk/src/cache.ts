/**
 * Kernel-owned read cache for plugin data（ADR-0022 D3 / P10–P12）。
 *
 * 为什么缓存归内核而不是插件：在集群里一个插件自己无法正确失效别人的副本——
 * 它看不到其他副本的内存，也没有权限广播。若放任插件自建进程内缓存，就出现了
 * 一条**绕过内核**的第二套数据通道，那正是 ADR-0001 / ADR-0021 要禁止的特权通道。
 * 因此内核提供机制（存储、边界、跨副本失效），插件只负责声明依赖。
 *
 * 失效是**声明式**的：调用方给出这份值派生自哪些自定义模型 kind，内核在这些
 * kind 被写入时自动失效，无需插件记得手动清理。声明了 `volatileFields` 的字段
 * （例如 `lastUsedAt` 这类只增统计列）写入**不会**失效——否则每请求一次结算就
 * 会把读缓存打穿，缓存等于不存在（见 PLAN-perf-hardening P11）。
 *
 * 边界：条目数与总字节有上限（LRU 逐出），TTL 有硬上限（陈旧窗口的上界），
 * 同一个 key 的并发回源被合并（防击穿）。缓存只用于**读多写少的配置类数据**；
 * 余额、额度、限流、会话等一致性敏感状态一律继续走 `ctx.state` / 内核服务，
 * 不得放进这里（ADR-0017 §2）。
 */

/** 一次受控读取的依赖与边界声明。 */
export interface CacheReadOptions {
  /**
   * 陈旧窗口的硬上限（毫秒）。即使失效广播丢失，最多也只服务这么久。
   * 内核会再取一个全局上限（`ttlMs` 只会被调小，不会被放大）。
   */
  ttlMs: number;
  /**
   * 这份值派生自哪些自定义模型 kind（如 `llm-gateway/model-price`）。
   * 这些 kind 的任何**非 volatile** 写入都会让本条失效（所有副本）。
   */
  kinds: readonly string[];
}

export interface CacheService {
  /**
   * 读穿缓存：命中直接返回，未命中调用 `loader` 并缓存结果。
   *
   * 同一个 key 的并发调用只会有一次真正执行 `loader`，其余等待同一结果。
   * `loader` 抛错时不缓存，错误原样抛出。
   *
   * 值必须是 JSON 可序列化的（要能跨副本与跨进程传递）。
   */
  remember<T>(key: string, options: CacheReadOptions, loader: () => Promise<T>): Promise<T>;

  /**
   * 显式失效：立刻丢弃所有派生自 `kind` 的条目（含其他副本）。
   * 写入路径已自动失效，这个方法只给「内核之外改了数据」的场景兜底。
   */
  invalidate(kind: string): Promise<void>;
}
