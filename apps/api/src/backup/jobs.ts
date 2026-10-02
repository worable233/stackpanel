/**
 * Kernel job handlers for export/import (ADR-0018 §3).
 *
 * Registered by the kernel on every job consumer (API replicas and the worker)
 * so a queued backup runs wherever it is picked up, instead of depending on a
 * bounded retry to reach the one process that happens to hold the handler.
 * Each handler drives the archive work and reports progress/result to the
 * shared control-plane status so any replica's `GET /admin/backup` reflects it.
 */
import type { JobContext } from '@stackpanel/sdk';
import { runExportJob, runImportJob } from './service.ts';
import { normalizeDomains } from './domains.ts';
import {
  BACKUP_JOBS,
  refreshBackupRun,
  setBackupError,
  setBackupProgress,
  setBackupResult,
  type BackupAction,
} from './control.ts';

interface BackupJobPayload {
  requestedBy?: string | null;
  reason?: string;
  /** Export: domains to include; omit for whole-instance (ADR-0018 §7). */
  includes?: string[];
  /** Export: include encrypted secrets (requires the key locally). */
  includeSecrets?: boolean;
  /** Import: object-storage key of the archive. */
  key?: string;
  /** Import: base64 archive uploaded directly. */
  archiveBase64?: string;
}

/** How often the runner renews its status lease (must be far below MAX_RUN_MS). */
const RUN_HEARTBEAT_MS = 60_000;

/** Execute one backup job and record its outcome. Never throws. */
export async function runBackupJob(action: BackupAction, payload: unknown): Promise<void> {
  const data = (payload ?? {}) as BackupJobPayload;
  const requestedBy = data.requestedBy ?? null;
  // Lease heartbeat: keeps a long-running job from being marked abandoned by a
  // concurrent `getBackupStatus()` on another replica.
  const heartbeat = setInterval(() => {
    void refreshBackupRun().catch(() => undefined);
  }, RUN_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    if (action === 'export') {
      const result = await runExportJob({
        requestedBy,
        ...(Array.isArray(data.includes) ? { includes: normalizeDomains(data.includes) } : {}),
        ...(data.includeSecrets ? { includeSecrets: true } : {}),
        onProgress: (detail) => void setBackupProgress(detail),
      });
      await setBackupResult({
        key: result.key,
        size: result.size,
        mediaCount: result.mediaCount,
        manifest: result.manifest,
      });
      return;
    }
    const archive = data.archiveBase64
      ? Uint8Array.from(Buffer.from(data.archiveBase64, 'base64'))
      : undefined;
    const result = await runImportJob({
      requestedBy,
      onProgress: (detail) => void setBackupProgress(detail),
      ...(archive ? { archive } : {}),
      ...(data.key ? { key: data.key } : {}),
    });
    await setBackupResult({ mediaCount: result.mediaCount, manifest: result.manifest });
  } catch (err) {
    await setBackupError(err instanceof Error ? err.message : String(err));
  } finally {
    clearInterval(heartbeat);
  }
}

/** Register the export/import handlers on a job context. */
export function registerBackupJobs(jobs: JobContext): void {
  jobs.handle(BACKUP_JOBS.export, (payload: unknown) => runBackupJob('export', payload));
  jobs.handle(BACKUP_JOBS.import, (payload: unknown) => runBackupJob('import', payload));
}
