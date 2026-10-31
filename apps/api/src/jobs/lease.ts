/**
 * 跨副本任务租约 —— 无 Redis 时的单实例保证（对标 #12.5）。
 *
 * 为什么需要：`MemoryJobBackend` 每个副本各有自己的 `setInterval`，`N` 个副本
 * 就是 `N` 份定时器，同一 tick 会执行 `N` 次。开发环境无所谓，集群部署下
 * 「到期暂停」「回收站清理」这类动作被重复执行就是真问题（对标对象用配置表锁
 * + 5 分钟陈旧期解决同一件事）。
 *
 * 做法：一个 tick 开始前先抢租约（`INSERT ... ON CONFLICT ... WHERE 已过期`），
 * 抢到才执行。租约靠 `expiresAtMs` 自然过期，不依赖清理任务 —— 持有者被 kill
 * 之后，最迟 `ttlMs` 就有别的副本接手，不需要「检测死节点」那套。
 *
 * 只给进程内后端用：BullMQ 本身按队列抢占，再套一层租约只会让同一 job 的
 * 重试互相挡住。
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

/** 一个 tick 的执行许可。 */
export interface JobLease {
  /** 抢 `${name}` 的租约；返回 `true` 表示本次由本副本执行。 */
  tryAcquire(name: string, ttlMs: number): Promise<boolean>;
}

/** 租约只需要 `$queryRaw`，测试里可以给一个假实现。 */
export interface LeaseDb {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * 租约时长：等于任务间隔（下限 1s、上限 5 分钟）。
 *
 * 不能取「间隔的若干倍」：那会把有效频率压到几倍间隔以下 —— 抢到租约的副本
 * 每轮都成功，其余副本在整个租约窗口内全部跳过。取一个间隔，语义是
 * 「同一轮最多一个副本执行」，下一轮到谁抢到就谁跑。
 */
export function leaseTtlMs(everyMs: number): number {
  return Math.max(1_000, Math.min(everyMs, 5 * 60_000));
}

/** 持有者标识：仅用于排查「上一次是谁在跑」，不参与判定。 */
export function resolveLeaseHolder(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/** 基于数据库的租约。表结构见 `kernel_job_leases` 迁移。 */
export class DbJobLease implements JobLease {
  constructor(
    private readonly db: LeaseDb,
    private readonly holder: string = resolveLeaseHolder(),
  ) {}

  async tryAcquire(name: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    // 单条语句完成「插入或抢占已过期租约」，不需要事务：
    // 并发时 Postgres 行锁保证只有一个 UPDATE 命中 `expiresAtMs < now`。
    const rows = await this.db.$queryRaw<Array<{ name: string }>>`
      INSERT INTO "kernel_job_leases" ("name", "holder", "expiresAtMs")
      VALUES (${name}, ${this.holder}, ${BigInt(now + ttlMs)})
      ON CONFLICT ("name") DO UPDATE
        SET "holder" = EXCLUDED."holder",
            "expiresAtMs" = EXCLUDED."expiresAtMs"
        WHERE "kernel_job_leases"."expiresAtMs" < ${BigInt(now)}
      RETURNING "name"
    `;
    return rows.length > 0;
  }
}
