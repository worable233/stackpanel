/**
 * Backup control plane: trigger export/import jobs and track status (ADR-0018).
 *
 * Export/import are long-running, so a POST only *queues* a kernel job and
 * returns immediately (202). The work runs on whichever consumer picks it up,
 * so both the status and the single-flight guard live in the shared
 * {@link StateService} (Redis in a cluster, in-process in development) rather
 * than process memory — otherwise a second replica would see `idle`, let a
 * concurrent destructive import through, and show stale progress.
 *
 * Crash recovery: a running status carries `runExpiresAt`. A runner heartbeats
 * it; if the runner dies, a later read marks the job failed and a new request
 * is allowed, so the cluster never wedges.
 */
import { getStateService } from '../state/index.ts';
import { createKernelJobContext, getJobRuntime } from '../jobs/index.ts';
import { enterMaintenance, exitMaintenance } from './service.ts';
import type { ExportManifest } from './manifest.ts';

/** Kernel-owned job names (reserved `kernel.` namespace). */
export const BACKUP_JOBS = {
  export: 'backup.export',
  import: 'backup.import',
} as const;

export type BackupAction = 'export' | 'import';
export type BackupState = 'idle' | 'running' | 'succeeded' | 'failed';

export interface BackupStatus {
  state: BackupState;
  action: BackupAction | null;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** After this ISO time a still-`running` job is treated as abandoned. */
  runExpiresAt: string | null;
  /** One-line progress detail. */
  detail: string | null;
  error: string | null;
  /** Result summary on success. */
  result: {
    key?: string;
    size?: number;
    mediaCount?: number;
    manifest?: ExportManifest;
  } | null;
}

const STATUS_KEY = 'backup:status';
/** Mutex for the check-then-set transition only (milliseconds of work). */
const CONTROL_LOCK_KEY = 'backup:control';
/** How long a terminal job result is retained for the admin UI. */
const STATUS_TTL_MS = 7 * 24 * 60 * 60_000;
const CONTROL_LOCK_TTL_MS = 10_000;
/** Upper bound on one export/import, renewed by the runner's heartbeat. */
const MAX_RUN_MS = 2 * 60 * 60_000;

function idle(): BackupStatus {
  return {
    state: 'idle',
    action: null,
    requestedAt: null,
    startedAt: null,
    finishedAt: null,
    runExpiresAt: null,
    detail: null,
    error: null,
    result: null,
  };
}

function isRunExpired(status: BackupStatus): boolean {
  return status.runExpiresAt !== null && Date.parse(status.runExpiresAt) <= Date.now();
}

async function writeStatus(status: BackupStatus): Promise<void> {
  await getStateService().set(STATUS_KEY, JSON.stringify(status), STATUS_TTL_MS);
}

/** Read the raw stored status without reconciliation. */
async function readStatus(): Promise<BackupStatus | null> {
  const raw = await getStateService().get(STATUS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BackupStatus;
  } catch {
    return null;
  }
}

/**
 * The current status, reconciling a `running` job whose runner has stopped
 * heartbeating (crash / forced kill) into a `failed` terminal state so the
 * cluster can accept a new request instead of blocking forever.
 */
export async function getBackupStatus(): Promise<BackupStatus> {
  const status = await readStatus();
  if (!status) return idle();
  if (status.state === 'running' && isRunExpired(status)) {
    const stale: BackupStatus = {
      ...status,
      state: 'failed',
      finishedAt: new Date().toISOString(),
      runExpiresAt: null,
      detail: null,
      error: '任务超时或执行进程已退出',
    };
    await writeStatus(stale);
    return stale;
  }
  return status;
}

/** Test seam: drop the stored status. */
export async function resetBackupStatus(): Promise<void> {
  await getStateService().del(STATUS_KEY);
}

/** Update the progress detail while a job runs. */
export async function setBackupProgress(detail: string): Promise<void> {
  const status = await readStatus();
  if (status?.state === 'running') await writeStatus({ ...status, detail });
}

/** Extend the running job's lease (runner heartbeat). */
export async function refreshBackupRun(ttlMs = MAX_RUN_MS): Promise<void> {
  const status = await readStatus();
  if (status?.state === 'running') {
    await writeStatus({ ...status, runExpiresAt: new Date(Date.now() + ttlMs).toISOString() });
  }
}

/** Mark the current job succeeded with a result summary. */
export async function setBackupResult(result: BackupStatus['result']): Promise<void> {
  const status = (await readStatus()) ?? idle();
  await writeStatus({
    ...status,
    state: 'succeeded',
    finishedAt: new Date().toISOString(),
    runExpiresAt: null,
    detail: null,
    error: null,
    result,
  });
}

/** Mark the current job failed. */
export async function setBackupError(error: string): Promise<void> {
  const status = (await readStatus()) ?? idle();
  await writeStatus({
    ...status,
    state: 'failed',
    finishedAt: new Date().toISOString(),
    runExpiresAt: null,
    detail: null,
    error,
  });
}

/** How the control plane is launched; overridable in tests. */
export type BackupExecutor = (
  action: BackupAction,
  payload: Record<string, unknown>,
) => Promise<void>;

interface JobSpec {
  requestedBy: string | null;
  reason: string;
}

const defaultExecutor: BackupExecutor = async (action, payload) => {
  const jobs = createKernelJobContext('kernel', getJobRuntime());
  const name = action === 'export' ? BACKUP_JOBS.export : BACKUP_JOBS.import;
  // Exports are not safely retryable in place; a failed one is re-requested.
  await jobs.enqueue(name, payload, { attempts: 1 });
};

let executor: BackupExecutor = defaultExecutor;

/** Inject an executor (tests only); pass `null` to restore the default. */
export function setBackupExecutor(next: BackupExecutor | null): void {
  executor = next ?? defaultExecutor;
}

export class BackupBusyError extends Error {}

/**
 * Queue one export/import. The check-then-set is serialized under a shared
 * latch so two replicas cannot both enqueue; a second request while a job runs
 * (or a concurrent request from another replica) is refused rather than
 * coalesced, because a double-submitted destructive import must be visible.
 *
 * For imports, maintenance is entered here — before the job is enqueued — so
 * writes stop cluster-wide the instant the request is accepted, not whenever a
 * consumer later picks the job up.
 */
export async function requestBackup(
  action: BackupAction,
  spec: JobSpec,
  payload: Record<string, unknown> = {},
): Promise<BackupStatus> {
  const state = getStateService();
  const acquired = await state.withLock(CONTROL_LOCK_KEY, CONTROL_LOCK_TTL_MS, async () => {
    const current = await getBackupStatus();
    if (current.state === 'running') {
      throw new BackupBusyError('已有备份任务在执行中');
    }
    const now = Date.now();
    await writeStatus({
      ...idle(),
      state: 'running',
      action,
      requestedAt: new Date(now).toISOString(),
      runExpiresAt: new Date(now + MAX_RUN_MS).toISOString(),
      detail: '已排队，等待执行',
    });
    if (action === 'import') await enterMaintenance('实例导入进行中');
    try {
      await executor(action, { ...spec, ...payload });
    } catch (err) {
      // The job never started; release maintenance so writes resume.
      if (action === 'import') await exitMaintenance().catch(() => undefined);
      await setBackupError(err instanceof Error ? err.message : String(err));
    }
  });
  if (!acquired) throw new BackupBusyError('已有备份任务在执行中');
  return getBackupStatus();
}
