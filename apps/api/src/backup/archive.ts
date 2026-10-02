/**
 * Export / import archive assembly (ADR-0018).
 *
 * An archive is a gzipped USTAR containing:
 *   manifest.json   format/version/engine + per-member SHA-256
 *   database.dump   pg_dump custom format (the whole instance schema + rows)
 *   media.tar       every object in the storage driver (brand, uploads, ...)
 *   checksums.txt   coreutils-style digests for out-of-band verification
 *
 * Export reads the database through `pg_dump` and the object store through the
 * {@link StorageDriver}, so it is storage-backend agnostic (local vs S3).
 * Import validates the manifest and every checksum *before* restoring, then
 * replaces the database and writes media back. It never merges (ADR-0018: this
 * is whole-instance migration, not content merge).
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'fflate';
import type { StorageDriver } from '@stackpanel/db';
import { createTar, extractTar, TarFormatError } from './tar.ts';
import {
  CHECKSUMS_FILE,
  DATABASE_FILE,
  EXPORT_DOMAINS,
  EXPORT_ENGINE,
  ExportValidationError,
  MANIFEST_FILE,
  MEDIA_FILE,
  parseChecksums,
  parseManifest,
  renderChecksums,
  sha256Hex,
  type ExportDomain,
  type ExportManifest,
} from './manifest.ts';
import {
  excludeTableDataFor,
  includesObjectStore,
  normalizeDomains,
} from './domains.ts';
import { runPgDump, runPgRestore, type PgDumpOptions } from './pg-tools.ts';

export class ExportError extends Error {}

export interface CreateArchiveInput {
  databaseUrl: string;
  storage: StorageDriver;
  appVersion: string;
  schemaVersion: string;
  /** Domains to include; omit for a whole-instance export (ADR-0018 §7). */
  includes?: ExportDomain[];
  secretsIncluded?: boolean;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Build the dump (tests inject a stub instead of calling pg_dump). */
  dump?: (databaseUrl: string, outputPath: string, options: PgDumpOptions) => Promise<void>;
}

export interface CreateArchiveResult {
  archive: Uint8Array;
  manifest: ExportManifest;
  /** Media objects packed into the archive. */
  mediaCount: number;
}

/** Build a complete export archive in memory. */
export async function createExportArchive(input: CreateArchiveInput): Promise<CreateArchiveResult> {
  const domains = normalizeDomains(input.includes);
  const secretsIncluded = input.secretsIncluded ?? false;
  const selective = domains.length < EXPORT_DOMAINS.length;
  const workdir = await mkdtemp(path.join(tmpdir(), 'sp-export-'));
  try {
    // 1. Database snapshot. Selective exports drop the *data* of unselected
    //    tables (their schema survives, so restore stays a plain pg_restore).
    const dumpPath = path.join(workdir, DATABASE_FILE);
    const excludeTableData = excludeTableDataFor(domains, secretsIncluded);
    const dumpOptions: PgDumpOptions = {};
    if (excludeTableData.length > 0) dumpOptions.excludeTableData = excludeTableData;
    await (input.dump ?? runPgDump)(input.databaseUrl, dumpPath, dumpOptions);
    const dumpBytes = await readFile(dumpPath);

    // 2. Media + resources from the object store (only when `media` is selected).
    const mediaEntries: Array<{ name: string; data: Uint8Array }> = [];
    if (includesObjectStore(domains)) {
      const objects = await input.storage.list();
      for (const object of objects) {
        const bytes = await input.storage.get(object.key);
        if (bytes) mediaEntries.push({ name: object.key, data: bytes });
      }
    }
    const mediaTar = createTar(mediaEntries);

    // 3. Manifest + checksums (members only; the manifest cannot checksum itself).
    const checksums: Record<string, string> = {
      [DATABASE_FILE]: sha256Hex(dumpBytes),
      [MEDIA_FILE]: sha256Hex(mediaTar),
    };
    const manifest: ExportManifest = {
      formatVersion: 1,
      appVersion: input.appVersion,
      schemaVersion: input.schemaVersion,
      exportedAt: (input.now?.() ?? new Date()).toISOString(),
      engine: EXPORT_ENGINE,
      includes: domains,
      selective,
      secretsIncluded,
      checksums,
    };
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    const checksumsBytes = new TextEncoder().encode(renderChecksums(checksums));

    // 4. USTAR, then gzip the whole thing.
    const tar = createTar([
      { name: MANIFEST_FILE, data: manifestBytes },
      { name: DATABASE_FILE, data: dumpBytes },
      { name: MEDIA_FILE, data: mediaTar },
      { name: CHECKSUMS_FILE, data: checksumsBytes },
    ]);
    const archive = gzipSync(tar);
    return { archive, manifest, mediaCount: mediaEntries.length };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/** Unpack an archive and validate its manifest + checksums before any write. */
export interface InspectedArchive {
  manifest: ExportManifest;
  dumpBytes: Uint8Array;
  mediaTar: Uint8Array;
  mediaCount: number;
}

/**
 * Decompress, parse and integrity-check an archive. Throws
 * {@link ExportValidationError} on any structural or checksum problem; no
 * database or storage write happens here.
 */
export function inspectArchive(archive: Uint8Array): InspectedArchive {
  let tarBytes: Uint8Array;
  try {
    tarBytes = gunzipSync(archive);
  } catch {
    throw new ExportValidationError('归档不是有效的 gzip 文件');
  }
  let files: Map<string, Uint8Array>;
  try {
    files = extractTar(tarBytes);
  } catch (error) {
    if (error instanceof TarFormatError) throw new ExportValidationError(error.message);
    throw error;
  }

  const manifestBytes = files.get(MANIFEST_FILE);
  if (!manifestBytes) throw new ExportValidationError('归档缺少 manifest.json');
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new ExportValidationError('manifest.json 不是合法 JSON');
  }
  const manifest = parseManifest(parsedRaw);

  const dumpBytes = files.get(DATABASE_FILE);
  if (!dumpBytes) throw new ExportValidationError('归档缺少 database.dump');
  const mediaTar = files.get(MEDIA_FILE);
  if (!mediaTar) throw new ExportValidationError('归档缺少 media.tar');

  // Cross-check checksums.txt (when present) against the manifest, then verify
  // both against the actual bytes. A mismatch means the archive was corrupted.
  const checksumsFile = files.get(CHECKSUMS_FILE);
  if (checksumsFile) {
    const declared = parseChecksums(new TextDecoder().decode(checksumsFile));
    for (const [name, digest] of Object.entries(declared)) {
      const fromManifest = manifest.checksums[name];
      if (fromManifest && fromManifest !== digest) {
        throw new ExportValidationError(`manifest 与 checksums.txt 不一致：${name}`);
      }
    }
  }
  const verify: Array<[string, Uint8Array]> = [
    [DATABASE_FILE, dumpBytes],
    [MEDIA_FILE, mediaTar],
  ];
  for (const [name, bytes] of verify) {
    const expected = manifest.checksums[name];
    if (!expected) throw new ExportValidationError(`manifest 缺少 ${name} 的校验和`);
    if (sha256Hex(bytes) !== expected) {
      throw new ExportValidationError(`校验失败：${name} 已损坏`);
    }
  }

  let mediaCount: number;
  try {
    mediaCount = extractTar(mediaTar).size;
  } catch {
    mediaCount = 0;
  }
  return { manifest, dumpBytes, mediaTar, mediaCount };
}

export interface ImportArchiveInput {
  archive: Uint8Array;
  databaseUrl: string;
  storage: StorageDriver;
  /** Compatibility gate: reject when the archive is newer than this instance. */
  currentSchemaVersion: string;
  /**
   * Called after validation and immediately before `pg_restore`. The API uses
   * it to release pooled connections so DROP does not block on this process.
   */
  beforeRestore?: () => Promise<void>;
  /** Restore the dump (tests inject a stub instead of calling pg_restore). */
  restore?: (databaseUrl: string, inputPath: string) => Promise<void>;
}

export interface ImportArchiveResult {
  manifest: ExportManifest;
  mediaCount: number;
}

/**
 * Restore an archive: validate, replace the database, then write media back.
 * The caller must ensure maintenance mode is active (writes rejected) for the
 * duration — see {@link MaintenanceMode}.
 */
export async function importExportArchive(input: ImportArchiveInput): Promise<ImportArchiveResult> {
  const { manifest, dumpBytes, mediaTar } = inspectArchive(input.archive);

  if (
    manifest.schemaVersion &&
    input.currentSchemaVersion &&
    compareVersions(manifest.schemaVersion, input.currentSchemaVersion) > 0
  ) {
    throw new ExportValidationError(
      `归档来自更新的版本（schema ${manifest.schemaVersion} > 当前 ${input.currentSchemaVersion}），` +
        '请先升级本实例再导入',
    );
  }

  const workdir = await mkdtemp(path.join(tmpdir(), 'sp-import-'));
  try {
    const dumpPath = path.join(workdir, DATABASE_FILE);
    await writeFile(dumpPath, dumpBytes);
    await input.beforeRestore?.();
    await (input.restore ?? runPgRestore)(input.databaseUrl, dumpPath);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }

  let mediaCount = 0;
  const mediaFiles = extractTar(mediaTar);
  for (const [key, data] of mediaFiles) {
    await input.storage.put(key, data);
    mediaCount += 1;
  }

  return { manifest, mediaCount };
}

/**
 * Compare dotted/numeric version strings (`20261001000000`, `1.2.3`). Missing
 * segments count as zero, so `1.2` equals `1.2.0`.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i += 1) {
    const na = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const nb = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}
