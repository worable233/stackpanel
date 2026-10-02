/**
 * Backup service: maintenance mode, version metadata and job bodies (ADR-0018).
 *
 * Import is destructive (it replaces the database), so the instance must stop
 * accepting writes first. This module owns a process-wide maintenance flag that
 * the API turns into a 503 write-guard while an import runs. The flag has a
 * hard TTL so a crashed import cannot wedge the instance forever.
 *
 * Export/import themselves are executed as kernel jobs on the worker, so they
 * never block a request (ADR-0013 §1). These functions are the job handlers.
 */
import { getPrisma } from '../plugins/prisma.ts';
import { getStorage } from '../infra.ts';
import { getStateService } from '../state/index.ts';
import { createExportArchive, importExportArchive, type CreateArchiveResult } from './archive.ts';
import { normalizeDomains, type ExportDomain } from './domains.ts';
import { isSecretsEnabled } from '../lib/crypto.ts';
import type { ExportManifest } from './manifest.ts';

/** Kernel version reported in the manifest (aligned with the OpenAPI version). */
export const KERNEL_APP_VERSION = '0.4.0';

// --- Maintenance mode ------------------------------------------------------
//
// The flag lives in the shared StateService (Redis in a cluster, in-process in
// development) rather than process memory. The import runs on whichever
// consumer picks up the job, while the write-guard runs in every API replica;
// a shared, TTL-bound flag is the only way all replicas observe the same window
// and a crashed importer cannot wedge the cluster.

/** Shared maintenance flag (ADR-0018 §4). */
export interface MaintenanceState {
  reason: string;
  /** When the instance entered maintenance (ISO 8601). */
  since: string;
  /** When the flag lapses unless renewed (ISO 8601). */
  until: string;
}

const MAINTENANCE_KEY = 'backup:maintenance';

/** Default window: covers a queued import plus a normal-length run. */
const DEFAULT_MAINTENANCE_MS = 30 * 60_000;

/** How often a running import renews the flag (must be far below the TTL). */
const MAINTENANCE_HEARTBEAT_MS = 60_000;

/** Whether writes are currently rejected because an import is in progress. */
export async function isMaintenanceMode(): Promise<MaintenanceState | null> {
  const raw = await getStateService().get(MAINTENANCE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MaintenanceState;
  } catch {
    return null;
  }
}

/**
 * Enter or renew maintenance for `ttlMs`. A renewal keeps the original `since`
 * so the window reads as one continuous episode from request to completion.
 */
export async function enterMaintenance(
  reason: string,
  ttlMs = DEFAULT_MAINTENANCE_MS,
): Promise<void> {
  const now = Date.now();
  const existing = await isMaintenanceMode();
  const state: MaintenanceState = {
    reason,
    since: existing?.since ?? new Date(now).toISOString(),
    until: new Date(now + ttlMs).toISOString(),
  };
  await getStateService().set(MAINTENANCE_KEY, JSON.stringify(state), ttlMs);
}

/** Leave maintenance; writes resume immediately on every replica. */
export async function exitMaintenance(): Promise<void> {
  await getStateService().del(MAINTENANCE_KEY);
}

/** Test seam: clear the flag. */
export async function resetMaintenance(): Promise<void> {
  await getStateService().del(MAINTENANCE_KEY);
}

// --- Version metadata ------------------------------------------------------

/**
 * The schema version the running instance is at: the newest applied Prisma
 * migration. Read from the database so it reflects reality, not the source
 * tree (which may be ahead during a rolling deploy).
 */
export async function currentSchemaVersion(): Promise<string> {
  try {
    const rows = await getPrisma().$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `;
    return rows[0]?.migration_name ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The database connection string used by the pg tools. */
function databaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('未配置 DATABASE_URL');
  return url;
}

/**
 * Where a running instance's database lives, for external automation
 * (gap C8: cron/off-site scripts need to target the same PostgreSQL the API
 * uses without re-deriving it). Never includes a password: the URL's userinfo
 * is stripped before it leaves the process.
 */
export interface DatabaseLocation {
  host: string;
  port: number;
  database: string;
  user: string | null;
}

export function databaseLocation(): DatabaseLocation | null {
  let url: string;
  try {
    url = databaseUrl();
  } catch {
    return null;
  }
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 5432,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
      user: parsed.username || null,
    };
  } catch {
    return null;
  }
}

/** Whether secrets can be exported/restored on this instance (key configured). */
export function secretsExportAvailable(): boolean {
  return isSecretsEnabled();
}

// --- Job bodies ------------------------------------------------------------

export interface ExportJobResult {
  manifest: ExportManifest;
  mediaCount: number;
  size: number;
  checksums: Record<string, string>;
}

/** Run one export (whole-instance or selective) and persist it to storage. */
export async function runExportJob(input: {
  requestedBy: string | null;
  /** Domains to include; omit for whole-instance (ADR-0018 §7). */
  includes?: ExportDomain[];
  /** Include encrypted secrets (requires the key locally, ADR-0018 §6). */
  includeSecrets?: boolean;
  onProgress?: (detail: string) => void;
  now?: () => Date;
}): Promise<ExportJobResult & { key: string }> {
  const domains = normalizeDomains(input.includes);
  const secretsIncluded = input.includeSecrets === true;
  if (secretsIncluded && !isSecretsEnabled()) {
    throw new Error('本实例未配置 SETTINGS_ENCRYPTION_KEY，无法导出密钥');
  }
  if (secretsIncluded) await enterMaintenance('实例导出（含密钥）进行中');
  try {
    input.onProgress?.('生成数据库快照');
    const schemaVersion = await currentSchemaVersion();
    const result: CreateArchiveResult = await createExportArchive({
      databaseUrl: databaseUrl(),
      storage: getStorage(),
      appVersion: KERNEL_APP_VERSION,
      schemaVersion,
      includes: domains,
      secretsIncluded,
      ...(input.now ? { now: input.now } : {}),
    });
    input.onProgress?.('写入归档');
    const key = `backups/export-${result.manifest.exportedAt.replace(/[:.]/g, '-')}.tar.gz`;
    await getStorage().put(key, result.archive, { contentType: 'application/gzip' });
    return {
      key,
      manifest: result.manifest,
      mediaCount: result.mediaCount,
      size: result.archive.byteLength,
      checksums: result.manifest.checksums,
    };
  } finally {
    // A secret-bearing export holds maintenance (writes paused) for the window
    // so the ciphertext snapshot is consistent; release it either way.
    if (secretsIncluded) await exitMaintenance().catch(() => undefined);
  }
}

/** Run one import from an object-storage or inline archive. */
export async function runImportJob(input: {
  archive?: Uint8Array;
  key?: string;
  requestedBy: string | null;
  onProgress?: (detail: string) => void;
}): Promise<{ manifest: ExportManifest; mediaCount: number }> {
  // The API already enters maintenance when it accepts the import (so writes
  // stop cluster-wide immediately); this re-enters/renews it so the window holds
  // even if the queue was slow to pick the job up, and heartbeats it so a long
  // restore never lets the flag lapse mid-run.
  await enterMaintenance('实例导入进行中');
  const heartbeat = setInterval(() => {
    void enterMaintenance('实例导入进行中').catch(() => undefined);
  }, MAINTENANCE_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    let archive = input.archive;
    if (!archive && input.key) {
      input.onProgress?.('读取归档');
      archive = (await getStorage().get(input.key)) ?? undefined;
    }
    if (!archive) throw new Error('未提供归档数据');
    input.onProgress?.('校验归档');
    const result = await importExportArchive({
      archive,
      databaseUrl: databaseUrl(),
      storage: getStorage(),
      currentSchemaVersion: await currentSchemaVersion(),
    });
    input.onProgress?.('导入完成，正在重载');
    return { manifest: result.manifest, mediaCount: result.mediaCount };
  } finally {
    clearInterval(heartbeat);
    await exitMaintenance();
  }
}
