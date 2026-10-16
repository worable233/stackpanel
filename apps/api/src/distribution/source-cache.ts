/**
 * 持久化分发源缓存（PLAN-github-distribution-and-updates §10）。
 *
 * 目录/资产的条件请求（ETag / Last-Modified）必须在**重启后仍然有效**，否则每次
 * 重启都会无条件重拉 GitHub，既浪费配额又放大限流风险。本模块把 {@link SourceCache}
 * 落到实例数据目录下，采用「临时文件 + rename」的原子写，读失败或只读环境降级为
 * 内存，绝不让缓存故障阻断分发链路。
 *
 * 与 `github-source.ts` 的分工：那层只做条件请求与约束，缓存**存取**由注入的实现
 * 承担；这里给出内核默认的文件实现。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MemorySourceCache, type SourceCache, type SourceCacheEntry } from './github-source.ts';

export interface FileSourceCacheOptions {
  /** 缓存根目录；缺省 `<data>/distribution/cache`。 */
  rootDir: string;
  /** 内存同时缓存一份，避免每次只读盘。 */
  memory?: MemorySourceCache;
}

/** 把任意缓存键映射为稳定的文件名（避免路径注入与大小写差异）。 */
export function cacheFileName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex')}.json`;
}

function isEntry(value: unknown): value is SourceCacheEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.body === 'string' && typeof entry.fetchedAt === 'string';
}

/**
 * 文件实现。任何 I/O 失败都静默降级（记日志由调用方决定），因此永远不会因为
 * 缓存写不进去而让一次目录刷新失败。
 */
export class FileSourceCache implements SourceCache {
  private readonly memory: MemorySourceCache;

  constructor(private readonly options: FileSourceCacheOptions) {
    this.memory = options.memory ?? new MemorySourceCache();
  }

  private fileFor(key: string): string {
    return path.join(this.options.rootDir, cacheFileName(key));
  }

  async get(key: string): Promise<SourceCacheEntry | null> {
    const cached = await this.memory.get(key);
    if (cached) return cached;
    try {
      const raw = await readFile(this.fileFor(key), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isEntry(parsed)) return null;
      await this.memory.set(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  async set(key: string, entry: SourceCacheEntry): Promise<void> {
    await this.memory.set(key, entry);
    const file = this.fileFor(key);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(this.options.rootDir, { recursive: true });
      await writeFile(tmp, JSON.stringify(entry), 'utf8');
      await rename(tmp, file);
    } catch {
      // Read-only volume / 权限不足：内存层已生效，条件请求降级但链路继续。
    }
  }
}
