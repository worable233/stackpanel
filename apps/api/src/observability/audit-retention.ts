/**
 * Audit-log retention (ADR-0015 §5).
 *
 * `AuditLog` is append-only by contract, so trimming is the one sanctioned
 * delete path. The policy is a rolling day window (`AUDIT_LOG_RETENTION_DAYS`,
 * default 180; `0` disables pruning) enforced by a kernel job rather than a
 * per-process timer, so it runs once across the cluster (ADR-0013 / S6).
 *
 * The kernel registers this through {@link registerAuditRetention} from its
 * `registerKernelJobs` assembly; the prune itself is bounded and idempotent.
 */
import { env } from '../config/env.ts';
import { getPrisma } from '../plugins/prisma.ts';
import type { JobContext } from '@stackpanel/sdk';

/** Job name (the kernel qualifies it to `kernel.audit.retention`). */
export const AUDIT_RETENTION_JOB = 'audit.retention';

/** Run once a day; retention is a slow-moving policy, not a hot path. */
export const AUDIT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Delete audit rows older than the retention window. Returns the number
 * removed. A window of `0` (disabled) is a no-op.
 */
export async function pruneAuditLogs(retentionDays = env.AUDIT_LOG_RETENTION_DAYS): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await getPrisma().auditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return count;
}

/**
 * Register the audit-retention job on the kernel job context. Called from the
 * kernel's `registerKernelJobs`; safe to call when retention is disabled (the
 * schedule is still registered but the handler no-ops).
 */
export async function registerAuditRetention(
  jobs: JobContext,
  options: { logger?: { warn: (m: string) => void } } = {},
): Promise<void> {
  jobs.handle(AUDIT_RETENTION_JOB, async () => {
    try {
      const removed = await pruneAuditLogs();
      if (removed > 0) {
        options.logger?.warn(`[audit] 审计保留策略清理 ${removed} 条过期记录`);
      }
    } catch (err) {
      options.logger?.warn(`[audit] 保留策略清理失败：${String(err)}`);
    }
  });
  await jobs.schedule(AUDIT_RETENTION_JOB, { everyMs: AUDIT_RETENTION_INTERVAL_MS });
}
