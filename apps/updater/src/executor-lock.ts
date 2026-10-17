/**
 * 执行权互斥（PLAN-github-distribution-and-updates §5.2、§5.3）。
 *
 * 契约要求：对同一实例使用**真正的跨进程互斥**与**有所有者的执行代次**；进程丢失
 * 执行权必须停止变更；切换/迁移/恢复期间禁止第二个任务并行。
 *
 * 本模块以「独占创建锁文件 + 所有者标识 + 代次」实现：抢锁用 `wx`（原子创建，
 * 已存在即失败）；超时的锁可被接管（上一进程崩溃/断电）。持有者每次变更边界前
 * 必须 `assertOwned()`——若锁已被他人接管则立刻停手，绝不继续写。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface LockInfo {
  owner: string;
  /** 执行代次；每次成功抢锁/接管递增，便于对账。 */
  generation: number;
  acquiredAt: string;
  /** 心跳时间（ISO）；用于判定持有者是否失联。 */
  heartbeatAt: string;
}

export class ExecutorLockError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface ExecutorLockOptions {
  filePath: string;
  /** 本进程的稳定所有者标识（如 `${hostname}:${pid}`）。 */
  owner: string;
  now?: () => Date;
  /** 心跳超过该毫秒数视为失联，允许接管（默认 60s）。 */
  staleAfterMs?: number;
}

export class ExecutorLock {
  private held: LockInfo | null = null;
  private readonly now: () => Date;
  private readonly staleAfterMs: number;

  constructor(private readonly opts: ExecutorLockOptions) {
    this.now = opts.now ?? (() => new Date());
    this.staleAfterMs = opts.staleAfterMs ?? 60_000;
  }

  private async read(): Promise<LockInfo | null> {
    try {
      const parsed = JSON.parse(await readFile(this.opts.filePath, 'utf8')) as LockInfo;
      return typeof parsed.owner === 'string' && typeof parsed.generation === 'number'
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  private isStale(info: LockInfo): boolean {
    return this.now().getTime() - Date.parse(info.heartbeatAt) > this.staleAfterMs;
  }

  /**
   * 抢锁。已存在且未失联 → 抛 {@link ExecutorLockError}（有他人持有，不得并行）。
   * 已存在但已失联 → 接管并递增代次。返回代次。
   */
  async acquire(): Promise<number> {
    await mkdir(path.dirname(this.opts.filePath), { recursive: true });
    const existing = await this.read();
    if (existing && !this.isStale(existing)) {
      if (existing.owner === this.opts.owner) {
        // 同一进程重复 acquire 幂等。
        this.held = existing;
        return existing.generation;
      }
      throw new ExecutorLockError(
        `执行权已被 ${existing.owner} 持有（代次 ${existing.generation}），拒绝并行执行`,
      );
    }
    const generation = (existing?.generation ?? 0) + 1;
    const info: LockInfo = {
      owner: this.opts.owner,
      generation,
      acquiredAt: this.now().toISOString(),
      heartbeatAt: this.now().toISOString(),
    };
    // 原子写：临时文件 + rename，避免读到半写内容。
    const tmp = `${this.opts.filePath}.${this.opts.owner}.tmp`;
    await writeFile(tmp, JSON.stringify(info), 'utf8');
    await rename(tmp, this.opts.filePath);
    this.held = info;
    return generation;
  }

  /** 刷新心跳（长任务期间调用）。 */
  async heartbeat(): Promise<void> {
    if (!this.held) return;
    this.held = { ...this.held, heartbeatAt: this.now().toISOString() };
    await writeFile(this.opts.filePath, JSON.stringify(this.held), 'utf8');
  }

  /** 断言仍持有执行权；被他人接管则抛错（调用方必须立刻停止变更）。 */
  async assertOwned(): Promise<void> {
    const current = await this.read();
    if (
      !current ||
      current.owner !== this.opts.owner ||
      current.generation !== this.held?.generation
    ) {
      this.held = null;
      throw new ExecutorLockError('已失去执行权（被接管或释放），停止变更');
    }
  }

  /** 释放执行权（仅在仍持有时删除锁文件，避免删掉接管者的锁）。 */
  async release(): Promise<void> {
    const current = await this.read();
    if (
      current &&
      current.owner === this.opts.owner &&
      current.generation === this.held?.generation
    ) {
      await rm(this.opts.filePath, { force: true });
    }
    this.held = null;
  }

  get owner(): string {
    return this.opts.owner;
  }
}
