/**
 * 更新权威操作日志（PLAN-github-distribution-and-updates §5.2、§5.3）。
 *
 * updater 在**独立持久卷**保存权威日志：任务投影、检查点、部署指针、旧新 digest、
 * 备份引用。硬性要求（§5.2）：
 * - 即使数据库迁移失败、业务库被恢复，本日志也**不倒退**（append-only，单调 seq）。
 * - 重启后先读现场再继续，不能凭内存里的阶段猜测（§5.3）。
 *
 * 因此这里只做一件事：把每次阶段完成的输入摘要与凭据**追加**到磁盘，读回时忽略
 * 损坏的尾行（断电可能留下半行），绝不覆盖或回退既有记录。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { UpdatePhase } from '@stackpanel/spec';

export interface JournalEntry {
  /** 单调递增序号（从 1 开始）。 */
  seq: number;
  at: string;
  instanceId: string;
  /** 幂等键：同一任务的全部检查点归于此。 */
  taskKey: string;
  phase: UpdatePhase;
  /** 该步骤输入的摘要（如目标 digest / 计划摘要）。 */
  inputDigest: string;
  /** 该步骤完成的凭据（探针结果 / 备份引用等），脱敏。 */
  credential?: string;
  note?: string;
}

/** 追加一条阶段记录所需的字段（seq 由日志分配）。 */
export interface JournalAppend {
  at: string;
  instanceId: string;
  taskKey: string;
  phase: UpdatePhase;
  inputDigest: string;
  credential?: string;
  note?: string;
}

/**
 * 文件实现：JSONL 追加写。读取容忍损坏尾行（断电留下的半行），其余记录照常返回。
 * seq 由「已持久化的最后一条」+1 得出，保证单调；并发由执行权互斥保证（§5.2）。
 */
export class FileUpdateJournal {
  private lastSeq = 0;
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private async load(): Promise<JournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      this.loaded = true;
      return [];
    }
    const entries: JournalEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as JournalEntry;
        if (typeof parsed.seq === 'number' && typeof parsed.phase === 'string') {
          entries.push(parsed);
        }
      } catch {
        // 损坏尾行（部分写入）：跳过，不影响已持久化记录。
      }
    }
    this.lastSeq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    this.loaded = true;
    return entries;
  }

  /** 全部已持久化记录，按 seq 升序。 */
  async entries(): Promise<JournalEntry[]> {
    const entries = await this.load();
    return [...entries].sort((a, b) => a.seq - b.seq);
  }

  /** 某任务的全部检查点，按 seq 升序。 */
  async forTask(taskKey: string): Promise<JournalEntry[]> {
    return (await this.entries()).filter((entry) => entry.taskKey === taskKey);
  }

  /** 某任务最近一次记录的阶段；没有则返回 null。 */
  async latestPhase(taskKey: string): Promise<UpdatePhase | null> {
    const task = await this.forTask(taskKey);
    return task.length > 0 ? (task[task.length - 1]?.phase ?? null) : null;
  }

  /** 追加一条记录并返回它（含分配的 seq）。 */
  async append(input: JournalAppend): Promise<JournalEntry> {
    if (!this.loaded) await this.load();
    const entry: JournalEntry = {
      seq: this.lastSeq + 1,
      at: input.at,
      instanceId: input.instanceId,
      taskKey: input.taskKey,
      phase: input.phase,
      inputDigest: input.inputDigest,
      ...(input.credential !== undefined ? { credential: input.credential } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    this.lastSeq = entry.seq;
    return entry;
  }
}
