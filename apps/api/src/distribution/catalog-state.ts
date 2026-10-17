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
  /** 已见过的最高目录 sequence；没有则为 0。 */
  highestSequence: number;
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

/** 文件实现；读失败视为空状态，写失败静默（调用方保底用内存值）。 */
export class FileCatalogStateStore {
  private cache: CatalogState | null = null;

  constructor(private readonly filePath: string) {}

  async read(): Promise<CatalogState> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      this.cache = isState(parsed) ? parsed : { ...EMPTY };
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

  /** 只在更高时推进，返回写回后的状态（保证单调不减）。 */
  async advance(sequence: number, channel: string, now: Date): Promise<CatalogState> {
    const current = await this.read();
    if (sequence <= current.highestSequence) {
      const same: CatalogState = {
        ...current,
        lastRefreshedAt: now.toISOString(),
        lastChannel: channel,
      };
      await this.write(same);
      return same;
    }
    const next: CatalogState = {
      highestSequence: sequence,
      lastRefreshedAt: now.toISOString(),
      lastChannel: channel,
    };
    await this.write(next);
    return next;
  }
}
