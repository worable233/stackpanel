import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';import path from 'node:path';
import type { FrontendManifest } from '@stackpanel/sdk';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import { FRONTEND_MANIFEST_FILE, FrontendError, isAllowedFrontendFile, validateFrontendFiles } from './frontend.ts';

/**
 * Contract 04 — content-addressed, immutable revision store.
 *
 * Every frontend package (theme or plugin) publishes its compiled artifacts as
 * one or more **immutable revision directories** named by a content digest. A
 * separate **current pointer** selects the active revision atomically (write
 * temp + rename). Old revisions are retained for a window so already-open
 * browser tabs keep resolving their chunks (§7).
 *
 * On-disk layout (relative to a package directory):
 *
 *   frontend/manifest.json        current manifest (kept for back-compat)
 *   frontend/dist/**              current dist (kept for back-compat)
 *   frontend/current.json         atomic pointer { revision, previous, at }
 *   frontend/revisions/<rev>/     immutable: manifest.json + dist/** + .ready
 *
 * The flat `manifest.json`/`dist/` remain the "materialized current" copy so
 * existing readers (`readFrontendManifest`, registry generation) are unchanged.
 */

const REVISION_PATTERN = /^[a-f0-9]{12,64}$/;
const READY_FILE = '.ready';
const POINTER_FILE = 'current.json';

export interface CurrentRevisionPointer {
  revision: string;
  previous: string | null;
  activatedAt: string;
}

export interface RevisionRecord {
  revision: string;
  /** Absolute path of the immutable revision directory. */
  dir: string;
  /** Whether the revision finished materializing (`.ready` present). */
  ready: boolean;
  /** mtime of the revision directory, best-effort. */
  createdAt: number | null;
}

/** `frontend/` under a package directory. */
export function frontendDir(packageDir: string): string {
  return path.join(packageDir, 'frontend');
}

/** `frontend/revisions/` under a package directory. */
export function revisionsDir(packageDir: string): string {
  return path.join(frontendDir(packageDir), 'revisions');
}

/** The immutable directory for one revision. */
export function revisionDir(packageDir: string, revision: string): string {
  return path.join(revisionsDir(packageDir), revision);
}

/** The atomic pointer file selecting the active revision. */
export function currentPointerPath(packageDir: string): string {
  return path.join(frontendDir(packageDir), POINTER_FILE);
}

/** Whether the revision name is a safe content digest (no traversal). */
export function isRevisionName(value: string): boolean {
  return REVISION_PATTERN.test(value);
}

/**
 * The canonical revision digest for a frontend package's bytes.
 *
 * The manifest body (with the `revision` field blanked, since it would be
 * circular) is folded into the hash alongside every shipped dist file, so the
 * digest covers **all externally-visible bytes** of the revision (contract 04
 * §1.2). The `frontend/manifest.json` member is skipped because its parsed body
 * is already folded — folding its raw bytes too would make the digest depend on
 * the (circular) `revision` field it carries.
 */
export function computeRevisionDigest(
  manifest: FrontendManifest | Omit<FrontendManifest, 'revision'>,
  files: Map<string, Uint8Array>,
): string {
  const hash = createHash('sha1');
  const manifestBody = JSON.stringify({ ...(manifest as Record<string, unknown>), revision: '' });
  hash.update('manifest\0');
  hash.update(manifestBody);
  for (const name of [...files.keys()].sort()) {
    if (name === FRONTEND_MANIFEST_FILE) continue;
    hash.update('\0file\0');
    hash.update(name);
    hash.update('\0');
    hash.update(files.get(name) ?? new Uint8Array());
  }
  return hash.digest('hex').slice(0, 12);
}

/** Read the atomic current-revision pointer, or null when absent/corrupt. */
export async function readCurrentRevision(
  packageDir: string,
): Promise<CurrentRevisionPointer | null> {
  try {
    const raw = await readFile(currentPointerPath(packageDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<CurrentRevisionPointer>;
    if (typeof parsed.revision !== 'string' || !isRevisionName(parsed.revision)) return null;
    return {
      revision: parsed.revision,
      previous: typeof parsed.previous === 'string' && isRevisionName(parsed.previous)
        ? parsed.previous
        : null,
      activatedAt: typeof parsed.activatedAt === 'string' ? parsed.activatedAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * Atomically switch the current pointer to `revision` (write temp + rename).
 * The previous revision is recorded so retention/rollback can reason about it.
 */
export async function activateRevision(packageDir: string, revision: string): Promise<void> {
  if (!isRevisionName(revision)) {
    throw new FrontendError(400, `非法的 revision：${revision}`);
  }
  // Contract 04 §4.2: never point the package at a revision that has not
  // finished materializing on this node. `.ready` is the last write of the
  // materializer, so its absence means a partially written directory.
  if (!existsSync(path.join(revisionDir(packageDir, revision), READY_FILE))) {
    throw new FrontendError(409, `revision 尚未就绪：${revision}`);
  }
  const target = currentPointerPath(packageDir);
  const previous = (await readCurrentRevision(packageDir))?.revision ?? null;
  const payload: CurrentRevisionPointer = {
    revision,
    previous: previous && previous !== revision ? previous : null,
    activatedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
}

/**
 * Materialize a validated set of frontend files into an immutable revision
 * directory and (optionally) activate it. Idempotent: re-publishing identical
 * bytes reuses the existing directory without rewriting it (dedup by digest).
 *
 * Returns the revision name and the pointer state.
 *
 * The caller is responsible for having validated the manifest (this function
 * re-validates defensively via {@link validateFrontendFiles}).
 */
export async function materializeRevision(
  packageDir: string,
  files: Map<string, Uint8Array>,
  options: { activate?: boolean } = {},
): Promise<{ revision: string; dir: string; reused: boolean; activated: boolean }> {
  const manifest = validateFrontendFiles(files);
  const revision = computeRevisionDigest(manifest, files);
  const dir = revisionDir(packageDir, revision);
  const readyPath = path.join(dir, READY_FILE);

  let reused = false;
  if (existsSync(readyPath)) {
    reused = true;
  } else {
    // Stage into a temp directory <revisions>/.<rev>.<pid>.tmp then rename.
    const staging = path.join(revisionsDir(packageDir), `.${revision}.${process.pid}.tmp`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      for (const [name, data] of files.entries()) {
        if (name === 'frontend/manifest.json') continue;
        if (!name.startsWith('frontend/')) continue;
        const relative = name.slice('frontend/'.length);
        const target = path.join(staging, relative);
        if (!target.startsWith(staging + path.sep)) {
          throw new FrontendError(422, `非法的前端文件：${name}`);
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, data);
      }
      // The revision's own manifest copy (with its revision recorded).
      await writeFile(
        path.join(staging, 'manifest.json'),
        `${JSON.stringify({ ...manifest, revision }, null, 2)}\n`,
        'utf8',
      );
      await mkdir(revisionsDir(packageDir), { recursive: true });
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
      // `.ready` is written last so a partially materialized dir is never
      // treated as complete (§4.2 "副本就绪后激活").
      await writeFile(readyPath, `${new Date().toISOString()}\n`, 'utf8');
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
  }

  let activated = false;
  if (options.activate !== false) {
    await activateRevision(packageDir, revision);
    activated = true;
  }
  // Contract 04 §1.2: the flat manifest's `revision` field must equal the
  // directory name. The publisher (e.g. `build:frontend`) computes its own
  // informational revision, so rewrite the flat manifest with the
  // kernel-authoritative digest. This keeps a single hashing algorithm.
  try {
    await writeFile(
      path.join(frontendDir(packageDir), 'manifest.json'),
      `${JSON.stringify({ ...manifest, revision }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // Best-effort: the revision store is already consistent on its own.
  }
  return { revision, dir, reused, activated };
}

/** Materialize an already-extracted flat `frontend/` directory into a revision. */
export async function materializeFromPackageDir(
  packageDir: string,
  options: { activate?: boolean } = {},
): Promise<{ revision: string; dir: string; reused: boolean; activated: boolean } | null> {
  const root = frontendDir(packageDir);
  const files = new Map<string, Uint8Array>();
  const walk = async (relative: string): Promise<void> => {
    const full = path.join(root, relative);
    let entries: string[];
    try {
      entries = await readdir(full);
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry}` : entry;
      if (rel === 'revisions' || rel === POINTER_FILE || rel === READY_FILE) continue;
      const childFull = path.join(root, rel);
      const info = await stat(childFull);
      if (info.isDirectory()) {
        await walk(rel);
        continue;
      }
      const name = `frontend/${rel}`;
      if (!isAllowedFrontendFile(name)) continue;
      files.set(name, new Uint8Array(await readFile(childFull)));
    }
  };
  await walk('');
  if (!files.has('frontend/manifest.json')) return null;
  try {
    return await materializeRevision(packageDir, files, options);
  } catch {
    return null;
  }
}

/**
 * Ensure a package's flat `frontend/` is published as a current revision.
 *
 * Idempotent and cheap when already current: computes the digest of the flat
 * bytes; if the current pointer already names that digest (and the immutable
 * directory exists), returns immediately. This is the kernel's fallback so any
 * package that landed on disk via a path that did not call
 * {@link materializeRevision} (e.g. `build:frontend`) still gets a revision.
 */
export async function ensureCurrentRevision(
  packageDir: string,
  options: { activate?: boolean } = {},
): Promise<{ revision: string; dir: string; reused: boolean; activated: boolean } | null> {
  const root = frontendDir(packageDir);
  const manifestName = 'frontend/manifest.json';
  let manifestRaw: Uint8Array;
  try {
    manifestRaw = new Uint8Array(await readFile(path.join(packageDir, manifestName)));
  } catch {
    return null;
  }
  // Collect the flat dist files (excluding the revision store itself).
  const files = new Map<string, Uint8Array>();
  files.set(manifestName, manifestRaw);
  const walk = async (relative: string): Promise<void> => {
    const full = path.join(root, relative);
    let entries: string[];
    try {
      entries = await readdir(full);
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry}` : entry;
      if (rel === 'revisions' || rel === POINTER_FILE || rel === READY_FILE) continue;
      const childFull = path.join(root, rel);
      const info = await stat(childFull);
      if (info.isDirectory()) {
        await walk(rel);
        continue;
      }
      const name = `frontend/${rel}`;
      if (!isAllowedFrontendFile(name)) continue;
      files.set(name, new Uint8Array(await readFile(childFull)));
    }
  };
  await walk('');
  let manifest: FrontendManifest;
  try {
    manifest = validateFrontendFiles(files);
  } catch {
    return null;
  }
  const revision = computeRevisionDigest(manifest, files);
  const current = await readCurrentRevision(packageDir);
  if (current?.revision === revision && existsSync(path.join(revisionDir(packageDir, revision), READY_FILE))) {
    return { revision, dir: revisionDir(packageDir, revision), reused: true, activated: false };
  }
  return materializeRevision(packageDir, files, options);
}

/** List materialized revisions, newest first (by mtime). */
export async function listRevisions(packageDir: string): Promise<RevisionRecord[]> {
  let names: string[];
  try {
    names = await readdir(revisionsDir(packageDir));
  } catch {
    return [];
  }
  const records: RevisionRecord[] = [];
  for (const name of names) {
    if (!isRevisionName(name)) continue;
    const dir = revisionDir(packageDir, name);
    let createdAt: number | null;
    let ready: boolean;
    try {
      createdAt = (await stat(dir)).mtimeMs;
      ready = existsSync(path.join(dir, READY_FILE));
    } catch {
      continue;
    }
    records.push({ revision: name, dir, ready, createdAt });
  }
  records.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return records;
}

export interface RetentionPolicy {
  /** Keep at least this many newest revisions (including the current one). */
  retainCount: number;
  /** Keep revisions activated within this many ms. */
  retainMs: number;
}

/**
 * Default retention: keep the 5 newest revisions and anything touched within
 * 24h — whichever is more generous (contract 04 §7; window is configurable via
 * `STACKPANEL_FRONTEND_REVISION_RETAIN` / `..._RETAIN_MS`).
 */
export function revisionRetentionPolicy(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const count = Number.parseInt(env.STACKPANEL_FRONTEND_REVISION_RETAIN ?? '', 10);
  const ms = Number.parseInt(env.STACKPANEL_FRONTEND_REVISION_RETAIN_MS ?? '', 10);
  return {
    retainCount: Number.isFinite(count) && count > 0 ? count : 5,
    retainMs: Number.isFinite(ms) && ms > 0 ? ms : 24 * 60 * 60 * 1000,
  };
}

/**
 * Prune old revisions. The current revision is never deleted; a revision is
 * kept when it is among the newest `retainCount` OR newer than `retainMs`.
 * Deletion is atomic per-directory (rename to a tombstone then remove), so a
 * directory being served is never partially removed (§7).
 */
export async function pruneRevisions(
  packageDir: string,
  policy: RetentionPolicy = revisionRetentionPolicy(),
): Promise<string[]> {
  const current = (await readCurrentRevision(packageDir))?.revision ?? null;
  const records = await listRevisions(packageDir);
  const now = Date.now();
  const removed: string[] = [];
  for (const [index, record] of records.entries()) {
    if (record.revision === current) continue;
    if (index < policy.retainCount) continue;
    if (record.createdAt !== null && now - record.createdAt < policy.retainMs) continue;
    const tombstone = `${record.dir}.removing.${process.pid}`;
    try {
      await rename(record.dir, tombstone);
      await rm(tombstone, { recursive: true, force: true });
      removed.push(record.revision);
    } catch {
      // A concurrent prune/serve won the race; leave it for next time.
    }
  }
  return removed;
}

/**
 * Resolve a versioned asset path `<revision>/<asset...>` to a concrete file
 * inside the immutable revision directory. Returns null when the revision is
 * unknown or the asset escapes the directory. The legacy flat layout
 * (`<asset...>` without a revision prefix) is handled by the caller.
 */
export function resolveRevisionAsset(
  packageDir: string,
  revision: string,
  asset: string,
): string | null {
  if (!isRevisionName(revision)) return null;
  if (asset.includes('..') || asset.includes('\\') || asset.includes('\0')) return null;
  const base = revisionDir(packageDir, revision);
  const full = path.resolve(base, asset);
  if (!full.startsWith(base + path.sep)) return null;
  return full;
}

/** Data-dir-relative path used to expose a revision asset over the BFF. */
export function revisionAssetPath(
  kind: 'themes' | 'plugins',
  id: string,
  revision: string,
  asset: string,
): string {
  return `/${kind}/${id}/frontend/${revision}/${asset.replace(/^\/+/, '')}`;
}

/** Resolve the absolute frontend root for a package (used by callers/tests). */
export function resolveFrontendPackageDir(kind: 'themes' | 'plugins', id: string): string {
  return path.join(resolveStackPanelDataDir(), kind, id);
}

/**
 * Copy the immutable revision store from a prior package directory into the
 * freshly written one, so revisions referenced by already-open browser tabs keep
 * resolving after an upgrade (contract 04 §7). Existing (identical-digest)
 * directories are left untouched; only missing ones are copied. Best-effort:
 * failures never block the install.
 *
 * Returns the number of revisions preserved.
 */
export async function preserveRevisions(
  fromPackageDir: string,
  toPackageDir: string,
): Promise<number> {
  const fromRoot = revisionsDir(fromPackageDir);
  if (!existsSync(fromRoot)) return 0;
  let names: string[];
  try {
    names = await readdir(fromRoot);
  } catch {
    return 0;
  }
  let copied = 0;
  for (const name of names) {
    if (!isRevisionName(name)) continue;
    const from = path.join(fromRoot, name);
    const to = revisionDir(toPackageDir, name);
    // Only preserve a fully materialized revision.
    if (!existsSync(path.join(from, READY_FILE)) || existsSync(to)) continue;
    try {
      await cp(from, to, { recursive: true });
      copied += 1;
    } catch {
      // Ignore: a partial copy is never treated as ready.
      await rm(to, { recursive: true, force: true }).catch(() => {});
    }
  }
  return copied;
}
