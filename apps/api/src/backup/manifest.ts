/**
 * Export archive manifest + integrity (ADR-0018 §2, §5).
 *
 * The manifest describes what an export contains and the exact bytes of each
 * member, so import can reject a corrupted or incompatible archive *before*
 * touching the database. `checksums.txt` carries the same digests in the
 * conventional `<sha256>  <name>` shape for out-of-band verification.
 */
import { createHash } from 'node:crypto';
import { isExportDomain, type ExportDomain } from './domains.ts';

/** Fixed engine marker; PostgreSQL is the only supported store (ADR-0019). */
export const EXPORT_ENGINE = 'postgresql';

/** Files an export archive always contains. */
export const MANIFEST_FILE = 'manifest.json';
export const DATABASE_FILE = 'database.dump';
export const MEDIA_FILE = 'media.tar';
export const CHECKSUMS_FILE = 'checksums.txt';

/** Re-export the domain vocabulary so consumers have one import point. */
export type { ExportDomain } from './domains.ts';
export { EXPORT_DOMAINS, isExportDomain, normalizeDomains } from './domains.ts';

export interface ExportManifest {
  /** Format version of the archive layout itself. */
  formatVersion: 1;
  /** Kernel/app version that produced the export. */
  appVersion: string;
  /** Prisma migrations applied when the export was taken. */
  schemaVersion: string;
  /** ISO timestamp of the export. */
  exportedAt: string;
  /** Storage engine; always `postgresql`. */
  engine: typeof EXPORT_ENGINE;
  /** Which domains the archive carries (ADR-0018 §7). */
  includes: ExportDomain[];
  /**
   * Whole-instance (all domains) vs. a domain-scoped subset. Selective archives
   * drop the *data* of unselected tables but keep their schema, so restore is
   * still a plain `pg_restore` with no special merge step.
   */
  selective: boolean;
  /** Whether application secrets were included (default false, ADR-0018 §6). */
  secretsIncluded: boolean;
  /**
   * Domain names present in the archive that require the target instance to
   * hold the matching encryption key (e.g. `settings` when `secretsIncluded`).
   * Advisory: import uses it to warn instead of silently dropping data.
   */
  requiresSecrets?: ExportDomain[];
  /** Per-member SHA-256 digests, keyed by file name. */
  checksums: Record<string, string>;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Render the conventional coreutils checksums file for the given entries. */
export function renderChecksums(checksums: Record<string, string>): string {
  return (
    Object.entries(checksums)
      .map(([name, digest]) => `${digest}  ${name}`)
      .join('\n') + '\n'
  );
}

/** Parse a `checksums.txt` body into a name -> digest map. */
export function parseChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(trimmed);
    if (match && match[1] && match[2]) out[match[2]] = match[1];
  }
  return out;
}

export class ExportValidationError extends Error {}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Parse and validate an untrusted manifest object. */
export function parseManifest(raw: unknown): ExportManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ExportValidationError('manifest.json 不是合法的 JSON 对象');
  }
  const m = raw as Record<string, unknown>;
  if (m['formatVersion'] !== 1) {
    throw new ExportValidationError(`不支持的归档格式版本：${String(m['formatVersion'])}`);
  }
  if (m['engine'] !== EXPORT_ENGINE) {
    throw new ExportValidationError(
      `不支持的存储引擎：${String(m['engine'])}（仅支持 ${EXPORT_ENGINE}）`,
    );
  }
  if (!isString(m['appVersion']) || !isString(m['schemaVersion']) || !isString(m['exportedAt'])) {
    throw new ExportValidationError('manifest.json 缺少 appVersion/schemaVersion/exportedAt');
  }
  const includes = Array.isArray(m['includes'])
    ? (m['includes'].filter(isExportDomain) as ExportDomain[])
    : [];
  const checksums: Record<string, string> = {};
  if (m['checksums'] && typeof m['checksums'] === 'object' && !Array.isArray(m['checksums'])) {
    for (const [key, value] of Object.entries(m['checksums'] as Record<string, unknown>)) {
      if (isString(value)) checksums[key] = value;
    }
  }
  const requiresSecrets = Array.isArray(m['requiresSecrets'])
    ? (m['requiresSecrets'].filter(isExportDomain) as ExportDomain[])
    : undefined;
  return {
    formatVersion: 1,
    appVersion: m['appVersion'],
    schemaVersion: m['schemaVersion'],
    exportedAt: m['exportedAt'],
    engine: EXPORT_ENGINE,
    includes,
    // Older archives (format v1, pre-selective) have no `selective` flag; a
    // full four-domain `includes` is treated as whole-instance for compatibility.
    selective: m['selective'] === true,
    secretsIncluded: m['secretsIncluded'] === true,
    ...(requiresSecrets ? { requiresSecrets } : {}),
    checksums,
  };
}
