import 'server-only';

import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';

/**
 * Contract 04 §9 — web-replica local materialization.
 *
 * Node can only `import()` a filesystem path, so a replica that does not share a
 * volume with the kernel must pull the revision's bytes down before it can serve
 * it. The kernel mirrors every published revision into object storage (or serves
 * it from its own disk); this module is the consumer side: it fetches the
 * revision's `manifest.json` for the file list, downloads each file through the
 * kernel's public asset route, and writes a complete local revision directory.
 *
 * `.ready` is written **last**, so a partially downloaded directory is never
 * treated as servable (same rule as the kernel side, §4.2).
 */

const READY_FILE = '.ready';

function apiBaseUrl(): string {
  return (process.env.API_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
}

function revisionDir(kind: 'themes' | 'plugins', id: string, revision: string): string {
  return path.join(resolveStackPanelDataDir(), kind, id, 'frontend', 'revisions', revision);
}

/** In-flight localizations, so concurrent requests download a revision once. */
const g = globalThis as unknown as { __STACKPANEL_LOCALIZING__?: Map<string, Promise<boolean>> };
function inFlight(): Map<string, Promise<boolean>> {
  if (!g.__STACKPANEL_LOCALIZING__) g.__STACKPANEL_LOCALIZING__ = new Map();
  return g.__STACKPANEL_LOCALIZING__;
}

function isSafeRelative(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

interface RevisionManifest {
  files?: unknown;
}

async function downloadRevision(
  kind: 'themes' | 'plugins',
  id: string,
  revision: string,
): Promise<boolean> {
  const assetBase = `${apiBaseUrl()}/${kind}/${encodeURIComponent(id)}/frontend/${revision}`;
  const manifestResponse = await fetch(`${assetBase}/manifest.json`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!manifestResponse.ok) return false;
  const manifest = (await manifestResponse.json().catch(() => null)) as RevisionManifest | null;
  const declared = Array.isArray(manifest?.files) ? manifest.files : [];
  const relatives = declared
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.replace(/^frontend\//, ''))
    .filter(isSafeRelative);
  if (relatives.length === 0) return false;

  const target = revisionDir(kind, id, revision);
  if (existsSync(path.join(target, READY_FILE))) return true;
  const staging = `${target}.${process.pid}.web`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    for (const relative of relatives) {
      const response = await fetch(`${assetBase}/${relative}`, { cache: 'no-store' });
      if (!response.ok) {
        // A revision whose declared bytes are not all servable must never be
        // marked ready: fail closed and let the caller fall back.
        await rm(staging, { recursive: true, force: true });
        return false;
      }
      const data = new Uint8Array(await response.arrayBuffer());
      const destination = path.join(staging, relative);
      if (!destination.startsWith(staging + path.sep)) {
        await rm(staging, { recursive: true, force: true });
        return false;
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, data);
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    await writeFile(path.join(target, READY_FILE), `${new Date().toISOString()}\n`, 'utf8');
    return true;
  } catch {
    await rm(staging, { recursive: true, force: true });
    return false;
  }
}

/**
 * Ensure a revision exists locally, downloading it if necessary.
 *
 * Returns true when a complete local revision is available afterwards. This is
 * the explicit local-materialization step contract 04 §9 requires; with a shared
 * volume it short-circuits on the `.ready` check.
 */
export async function ensureLocalRevision(
  kind: 'themes' | 'plugins',
  id: string,
  revision: string,
): Promise<boolean> {
  if (existsSync(path.join(revisionDir(kind, id, revision), READY_FILE))) return true;
  const key = `${kind}:${id}:${revision}`;
  const cache = inFlight();
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = downloadRevision(kind, id, revision).finally(() => cache.delete(key));
  cache.set(key, pending);
  return pending;
}
