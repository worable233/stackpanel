import { existsSync } from 'node:fs';
import { readFile, readdir, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StorageDriver } from '@stackpanel/db';
import { getStorage } from '../infra.ts';
import { isRevisionName, materializeFromPackageDir, readCurrentRevision, revisionDir } from './frontend-revisions.ts';

/**
 * Contract 04 §9 — object-storage local materialization.
 *
 * A revision is always materialized into the local data dir before it can be
 * `import()`-ed by a web replica: Node's module loader only accepts filesystem
 * paths. When the deployment has no shared volume (object storage is
 * authoritative), that local copy is not automatic — a replica must explicitly
 * pull the revision bytes down before activation can succeed on it.
 *
 * Layout in the bucket:
 *
 *   frontend-revisions/<kind>/<id>/<revision>/<relative path inside revision>/
 *
 * The `<relative path>` is relative to the revision directory, i.e.
 * `manifest.json`, `dist/index.js`, `dist/index.css`, … so the mapping back to
 * the local immutable directory is a straight file copy.
 */

export type FrontendPackageKind = 'themes' | 'plugins';

const READY_FILE = '.ready';

/** Object-key prefix holding one immutable revision. */
export function revisionStoragePrefix(
  kind: FrontendPackageKind,
  id: string,
  revision: string,
): string {
  return `frontend-revisions/${kind}/${id}/${revision}`;
}

/** Reject traversal in a revision-relative path before it becomes a file path. */
function safeRelative(relative: string): boolean {
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.includes('\0')) {
    return false;
  }
  return relative.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

async function walkFiles(root: string, relative = ''): Promise<string[]> {
  const out: string[] = [];
  const full = relative ? path.join(root, relative) : root;
  let entries: string[];
  try {
    entries = await readdir(full);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry}` : entry;
    const child = path.join(root, rel);
    const info = await stat(child).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      out.push(...(await walkFiles(root, rel)));
      continue;
    }
    if (rel === READY_FILE) continue;
    out.push(rel);
  }
  return out;
}

/**
 * Mirror a locally materialized revision into object storage.
 *
 * Idempotent: content-addressed directories never change, so an existing object
 * is left as-is (put is only issued for missing keys). Best-effort by design —
 * the caller treats a failure as a warning, because the local store is still a
 * complete revision; the mirror only enables replicas without a shared volume.
 */
export async function publishRevisionToStorage(
  kind: FrontendPackageKind,
  id: string,
  revision: string,
  packageDir: string,
  storage: StorageDriver = getStorage(),
): Promise<number> {
  if (!isRevisionName(revision)) return 0;
  const driver = storage;
  // The local driver is the shared-volume path; mirroring to it is a no-op.
  if (driver.kind !== 's3') return 0;
  const localDir = revisionDir(packageDir, revision);
  if (!existsSync(path.join(localDir, READY_FILE))) return 0;
  const files = await walkFiles(localDir);
  let published = 0;
  for (const relative of files) {
    const key = `${revisionStoragePrefix(kind, id, revision)}/${relative}`;
    if (await driver.exists(key)) continue;
    const data = new Uint8Array(await readFile(path.join(localDir, relative)));
    await driver.put(key, data);
    published += 1;
  }
  return published;
}

/**
 * Read one revision-relative file from object storage, or null when the object
 * does not exist. Used by the versioned asset route as a fallback when a
 * replica has not localized the revision yet.
 */
export async function readRevisionObject(
  kind: FrontendPackageKind,
  id: string,
  revision: string,
  relative: string,
  storage: StorageDriver = getStorage(),
): Promise<Uint8Array | null> {
  if (!isRevisionName(revision) || !safeRelative(relative)) return null;
  const driver = storage;
  if (driver.kind !== 's3') return null;
  return driver.get(`${revisionStoragePrefix(kind, id, revision)}/${relative}`);
}

/** Every file of a revision, as stored in the bucket (revision-relative paths). */
export async function listRevisionObjects(
  kind: FrontendPackageKind,
  id: string,
  revision: string,
  storage: StorageDriver = getStorage(),
): Promise<string[]> {
  if (!isRevisionName(revision)) return [];
  const driver = storage;
  if (driver.kind !== 's3') return [];
  const prefix = `${revisionStoragePrefix(kind, id, revision)}/`;
  const objects = await driver.list(prefix);
  return objects
    .map((object) => object.key.slice(prefix.length))
    .filter((relative) => safeRelative(relative) && relative !== READY_FILE);
}

/**
 * Pull a revision from object storage into the local immutable directory and
 * mark it ready. This is the explicit "local materialization" step contract 04
 * §9 requires before a replica may serve (or activate) the revision.
 *
 * Writes into a temp directory first and renames it into place, so a crashed or
 * interrupted pull never looks like a complete revision. Returns null when the
 * bucket has no such revision.
 */
export async function localizeRevisionFromStorage(
  kind: FrontendPackageKind,
  id: string,
  revision: string,
  packageDir: string,
  storage: StorageDriver = getStorage(),
): Promise<{ dir: string; files: number } | null> {
  if (!isRevisionName(revision)) return null;
  const files = await listRevisionObjects(kind, id, revision, storage);
  if (files.length === 0) return null;
  const driver = storage;
  const target = revisionDir(packageDir, revision);
  if (existsSync(path.join(target, READY_FILE))) {
    return { dir: target, files: files.length };
  }
  const staging = `${target}.${process.pid}.pull`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    for (const relative of files) {
      if (!safeRelative(relative)) continue;
      const data = await driver.get(`${revisionStoragePrefix(kind, id, revision)}/${relative}`);
      if (!data) continue;
      const destination = path.join(staging, relative);
      if (!destination.startsWith(staging + path.sep)) continue;
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, data);
    }
    await rename(staging, target);
    // `.ready` last: a partial pull is never treated as complete (§4.2).
    await writeFile(path.join(target, READY_FILE), `${new Date().toISOString()}\n`, 'utf8');
    return { dir: target, files: files.length };
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

/** Whether a replica has a complete local copy of a revision. */
export function isRevisionLocalized(packageDir: string, revision: string): boolean {
  if (!isRevisionName(revision)) return false;
  return existsSync(path.join(revisionDir(packageDir, revision), READY_FILE));
}

/**
 * Materialize a package's flat `frontend/` into a revision **and** mirror it to
 * object storage when one is configured. This is the single entry point
 * publishers should call so the local store and the bucket never diverge.
 */
export async function materializeAndPublish(
  kind: FrontendPackageKind,
  id: string,
  packageDir: string,
  storage: StorageDriver = getStorage(),
): Promise<{ revision: string; dir: string; reused: boolean; activated: boolean } | null> {
  const result = await materializeFromPackageDir(packageDir).catch(() => null);
  if (!result?.revision) return result;
  await publishRevisionToStorage(kind, id, result.revision, packageDir, storage).catch(() => 0);
  return result;
}

/**
 * Mirror the package's **current** revision into object storage, if it has one.
 * Called right after a successful materialization so replicas without a shared
 * volume can localize it later (`localizeRevisionFromStorage`).
 */
export async function publishCurrentRevisionToStorage(
  kind: FrontendPackageKind,
  id: string,
  packageDir: string,
  storage: StorageDriver = getStorage(),
): Promise<number> {
  const pointer = await readCurrentRevision(packageDir);
  if (!pointer?.revision) return 0;
  return publishRevisionToStorage(kind, id, pointer.revision, packageDir, storage);
}
