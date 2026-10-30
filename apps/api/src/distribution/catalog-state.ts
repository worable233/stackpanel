/**
 * 目录回放保护状态（PLAN-github-distribution-and-updates §3.3、§10）。
 *
 * 契约要求「持久化最高 sequence，拒绝回放旧目录」。内存里的最高值在重启后会丢失，
 * 攻击者（或一次回滚）就能用一个旧的、仍然签名有效的目录把实例降级到含已知漏洞的
 * 版本。因此最高 sequence 必须**随手记在磁盘上**再用于下一次比较。
 *
 * 这里只管「已知最高 sequence」这一个小状态，不缓存目录内容本身（内容由
 * {@link FileSourceCache} 的条件请求缓存承担）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CatalogState {
  /** 跨渠道已见过的最高目录 sequence；没有则为 0。展示与旧文件兼容用，单调不减。 */
  highestSequence: number;
  /**
   * 各渠道**各自**见过的最高 sequence。
   *
   * 渠道的 sequence 是独立推进的：stable 可能落后于 beta。防回放基线必须按渠道比较，
   * 否则把渠道从 beta 切回 stable 时，stable 那条正常的（签名有效、未过期）快照会被
   * 判成回放，并连带触发最长 6 小时的失败退避——市场与更新中心在切换后会「坏掉」。
   *
   * 旧版本状态文件没有这个字段，由 channelBaseline() 兼容推断。
   */
  channels?: Record<string, number>;
  /** 最近一次成功刷新的时间（ISO），用于后台任务判断是否该再试。 */
  lastRefreshedAt?: string;
  /** 最近一次成功刷新的渠道，便于展示。 */
  lastChannel?: string;
}

const EMPTY: CatalogState = { highestSequence: 0 };

function isState(value: unknown): value is CatalogState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return Number.isInteger(state.highestSequence) && (state.highestSequence as number) >= 0;
}

/**
 * 某渠道的防回放基线：该渠道见过的最高 sequence，从未成功刷新过则为 0。
 *
 * 旧状态文件只有全局 highestSequence 与 lastChannel，无法区分渠道；此时只把旧值
 * 归给它记录的渠道，其余渠道按 0 处理——宁可重新接受一次，也不能把正常快照判成回放。
 */
export function channelBaseline(state: CatalogState, channel: string): number {
  const recorded = state.channels?.[channel];
  if (typeof recorded === 'number' && Number.isInteger(recorded) && recorded >= 0) return recorded;
  if (state.channels === undefined && state.lastChannel === channel) return state.highestSequence;
  return 0;
}

/**
 * 丢弃非法的 per-channel 条目，而不是让整份文件作废。
 *
 * 整份作废会让基线归零，等于给攻击者留一个降级窗口；丢条目只损失那一个渠道的记忆。
 */
function normalizeChannels(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const channels: Record<string, number> = {};
  for (const [channel, sequence] of Object.entries(value as Record<string, unknown>)) {
    if (channel.length === 0) continue;
    if (typeof sequence === 'number' && Number.isInteger(sequence) && sequence >= 0) {
      channels[channel] = sequence;
    }
  }
  return channels;
}

function normalizeState(state: CatalogState): CatalogState {
  const channels = normalizeChannels(state.channels);
  return {
    highestSequence: state.highestSequence,
    ...(typeof state.lastRefreshedAt === 'string'
      ? { lastRefreshedAt: state.lastRefreshedAt }
      : {}),
    ...(typeof state.lastChannel === 'string' ? { lastChannel: state.lastChannel } : {}),
    ...(channels ? { channels } : {}),
  };
}

/** 文件实现；读失败视为空状态，写失败静默（调用方保底用内存值）。 */
export class FileCatalogStateStore {
  private cache: CatalogState | null = null;

  constructor(private readonly filePath: string) {}

  async read(): Promise<CatalogState> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      this.cache = isState(parsed) ? normalizeState(parsed) : { ...EMPTY };
    } catch {
      this.cache = { ...EMPTY };
    }
    return this.cache;
  }

  async write(state: CatalogState): Promise<void> {
    this.cache = state;
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await rename(tmp, this.filePath);
    } catch {
      // 只读卷：内存值仍然生效，本轮刷新不因持久化失败而失败。
    }
  }

  /**
   * 记录某渠道成功验证过的最高 sequence，返回写回后的状态（单调不减）。
   *
   * 两个维度都保持单调：渠道自己的基线、以及跨渠道的 highestSequence。旧状态文件
   * 在首次推进时会把它的全局最高值迁移到对应渠道上，避免迁移瞬间丢掉基线。
   */
  async advance(sequence: number, channel: string, now: Date): Promise<CatalogState> {
    const current = await this.read();
    const channels: Record<string, number> = { ...(current.channels ?? {}) };
    if (current.channels === undefined && current.lastChannel !== undefined) {
      channels[current.lastChannel] = current.highestSequence;
    }
    channels[channel] = Math.max(channels[channel] ?? 0, sequence);
    const next: CatalogState = {
      highestSequence: Math.max(current.highestSequence, sequence),
      channels,
      lastRefreshedAt: now.toISOString(),
      lastChannel: channel,
    };
    await this.write(next);
    return next;
  }
}
