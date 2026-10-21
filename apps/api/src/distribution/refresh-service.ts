/**
 * 目录刷新协调器（PLAN-github-distribution-and-updates §10）。
 *
 * 契约要求：
 * - 后台任务定时检查（建议六小时 + 抖动）；
 * - 用户手动刷新也走**实例级合并请求**，同一时刻只允许一个在途刷新；
 * - 页面渲染路径**不直接**请求 GitHub；
 * - GitHub 不可达 / 限流 / 目录过期时业务照常，更新退避；不得为完成更新降低验签。
 *
 * 本模块把这些语义收敛成一个可注入、可测的协调器：单飞（single-flight）、失败退避、
 * 成功后推进防回放 sequence，并保留「上次成功的快照」供离线展示。它不关心快照如何
 * 被消费（安装/更新中心），只负责「安全地把最新已签名目录取回来」。
 */

import type { Keyring, ReleaseChannel } from '@stackpanel/spec';
import { fetchCatalog, type CatalogFetchOptions, type ResolvedCatalog } from './catalog-client.ts';
import { CatalogError } from './catalog-client.ts';
import type { SourceCache } from './github-source.ts';
import { GitHubSourceError } from './github-source.ts';
import type { FileCatalogStateStore } from './catalog-state.ts';

/** 默认后台刷新周期：6 小时，加最多 30 分钟抖动（§10）。 */
export const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_REFRESH_JITTER_MS = 30 * 60 * 1000;

export interface RefreshFailure {
  kind: string;
  message: string;
  /** 建议最早重试时间（ISO）；来自 Retry-After 或指数退避。 */
  retryAt?: string;
}

export interface CatalogRefreshResult {
  /** 本次是否真的发起了网络请求（合并请求时为 false）。 */
  fetched: boolean;
  /** 刷新结果；失败时为 null，错误见 {@link CatalogRefreshResult.failure}。 */
  resolved: ResolvedCatalog | null;
  failure: RefreshFailure | null;
}

export interface CatalogRefreshOptions extends CatalogFetchOptions {
  channel: ReleaseChannel;
  /** 目录仓，如 `worable233/stackpanel-market`。 */
  repository: string;
}

export interface CatalogRefreshServiceOptions {
  options: CatalogRefreshOptions;
  cache: SourceCache;
  state: FileCatalogStateStore;
  /** 信任根加载器；每次刷新现取，支持轮换。 */
  loadKeyring: () => Promise<Keyring>;
  now?: () => Date;
  intervalMs?: number;
  jitterMs?: number;
}

/** 计算指数退避（毫秒），上限 6 小时。 */
export function backoffMs(attempt: number): number {
  const base = 1000;
  const capped = Math.min(base * 2 ** Math.max(0, attempt - 1), DEFAULT_REFRESH_INTERVAL_MS);
  return capped;
}

/**
 * 单实例协调器。所有对 {@link refresh} 的并发调用共享同一个在途 Promise，
 * 因此「后台定时 + 多个管理员点击刷新」只会产生一次 GitHub 请求。
 */
export class CatalogRefreshService {
  private inFlight: Promise<CatalogRefreshResult> | null = null;
  private lastResolved: ResolvedCatalog | null = null;
  private lastFailure: RefreshFailure | null = null;
  private failureStreak = 0;
  private nextAllowedAt: number = 0;

  constructor(private readonly opts: CatalogRefreshServiceOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** 最近一次成功解析的快照（可能来自缓存），页面渲染只读这个，不发网络请求。 */
  current(): ResolvedCatalog | null {
    return this.lastResolved;
  }

  /**
   * 最近一次失败（成功后退避清零但失败记录保留到下次成功），供市场/更新中心展示
   * 「为什么目录不可用」——默认远程源开启后，缺信任根这类配置错误必须可见。
   */
  lastFailureInfo(): RefreshFailure | null {
    return this.lastFailure;
  }

  /**
   * 若无内存快照则触发一次（合并）刷新并返回结果；已有则直接返回。
   *
   * **失败退避生效**：退避期内直接返回 null，不再打 GitHub——否则市场页每刷新一次
   * 就会重试一次（默认远程源开启后，这条路径会被频繁走到）。
   */
  async ensureCurrent(): Promise<ResolvedCatalog | null> {
    if (this.lastResolved) return this.lastResolved;
    if (this.cooldownRemainingMs() > 0) return null;
    const result = await this.refresh();
    return result.resolved;
  }

  /** 条件请求缓存（安装消费端做 Release 下载时复用同一缓存）。 */
  get cache(): SourceCache {
    return this.opts.cache;
  }

  /** 当前配置的发布渠道。 */
  get channel(): ReleaseChannel {
    return this.opts.options.channel;
  }

  /** 当前配置的目录仓（用于后台诊断展示）。 */
  get repository(): string {
    return this.opts.options.repository;
  }

  /** 目录仓只读 token（可选）。 */
  get token(): string | undefined {
    return this.opts.options.token;
  }

  /** GitHub 加速前缀（可选）。 */
  get mirror(): string | undefined {
    return this.opts.options.mirror;
  }

  /**
   * 当前信任根（每次现取，支持轮换）。安装消费端与刷新协调器共用同一信任根，
   * 避免「刷新信任的包 key 与安装校验的 key 不一致」。
   */
  async loadTrustKeyring(): Promise<Keyring> {
    return this.opts.loadKeyring();
  }

  /** 定制的 `fetch`（测试注入；生产为 undefined，走全局 fetch）。 */
  get fetchImpl(): typeof fetch | undefined {
    return this.opts.options.fetchImpl;
  }

  /** 距离下次允许刷新还剩多少毫秒（0 表示可以立即刷新）。 */
  cooldownRemainingMs(): number {
    return Math.max(0, this.nextAllowedAt - this.now().getTime());
  }

  /** 是否到了后台定时刷新时间（含抖动）。 */
  isDue(lastCheckMs: number): boolean {
    const interval = this.opts.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    const jitter = Math.floor(
      ((this.opts.jitterMs ?? DEFAULT_REFRESH_JITTER_MS) as number) * Math.random(),
    );
    return this.now().getTime() - lastCheckMs >= interval + jitter;
  }

  /** 合并刷新的入口：并发调用只发起一次网络请求。 */
  async refresh(): Promise<CatalogRefreshResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<CatalogRefreshResult> {
    const now = this.now();
    const state = await this.opts.state.read();
    try {
      const keyring = await this.opts.loadKeyring();
      const resolved = await fetchCatalog(
        this.opts.options,
        this.opts.cache,
        keyring,
        this.opts.options.channel,
        state.highestSequence,
        now,
      );
      // 仅在**验证通过**后才推进防回放 sequence；失败绝不推进。
      await this.opts.state.advance(resolved.sequence, this.opts.options.channel, now);
      this.lastResolved = resolved;
      this.lastFailure = null;
      this.failureStreak = 0;
      this.nextAllowedAt = 0;
      return { fetched: true, resolved, failure: null };
    } catch (error) {
      this.failureStreak += 1;
      const failure = classifyFailure(error, this.failureStreak, now);
      this.lastFailure = failure;
      this.nextAllowedAt = this.now().getTime() + backoffMs(this.failureStreak);
      return { fetched: true, resolved: null, failure };
    }
  }
}

/** 把底层错误归类为可展示、可退避的失败描述。 */
export function classifyFailure(error: unknown, attempt: number, now: Date): RefreshFailure {
  if (error instanceof GitHubSourceError) {
    const retryAt =
      error.retryAfterMs !== undefined
        ? new Date(now.getTime() + error.retryAfterMs).toISOString()
        : error.kind === 'rate_limited'
          ? new Date(now.getTime() + backoffMs(attempt)).toISOString()
          : undefined;
    return retryAt !== undefined
      ? { kind: error.kind, message: error.message, retryAt }
      : { kind: error.kind, message: error.message };
  }
  if (error instanceof CatalogError) {
    // 默认远程源开启后，「没有信任根」是最常见的配置错误。原始报错是
    // 「目录签名者未被信任：xxx」，运维看不出该去做什么，这里补上可执行指引。
    const hint =
      error.kind === 'signature' && /未被信任|找不到目录签名公钥/.test(error.message)
        ? '：实例信任根缺少该目录签名公钥，请把发布方的公钥写入 <数据目录>/trust/keyring.json（purpose=catalog）'
        : '';
    return { kind: error.kind, message: `${error.message}${hint}` };
  }
  return {
    kind: 'unknown',
    message: error instanceof Error ? error.message : String(error),
  };
}
