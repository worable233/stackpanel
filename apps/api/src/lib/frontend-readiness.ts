import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveStackPanelDataDir } from '@stackpanel/sdk/paths';
import {
  isRevisionName,
  readCurrentRevision,
  revisionDir,
} from './frontend-revisions.ts';

/**
 * Contract 04 §4.2 — replica readiness signal.
 *
 * Activation is only safe once the target revision is visible **and complete**
 * on every web replica that will serve it. `.ready` is written last by the
 * materializer, so its presence is the authoritative "this replica can serve
 * this revision" bit. This module turns that bit into an observable signal: the
 * readiness probe (and therefore the orchestrator) can refuse to route traffic
 * to a replica that has not finished materializing.
 */

export type FrontendReadinessKind = 'themes' | 'plugins';

export interface FrontendReadinessEntry {
  kind: FrontendReadinessKind;
  id: string;
  /** Active content-addressed revision, or null when the package is flat-only. */
  revision: string | null;
  /** Whether the package publishes a compiled frontend at all. */
  hasFrontend: boolean;
  /**
   * Whether this replica can serve the active revision. True when the `.ready`
   * sentinel exists, or — for legacy/flat-only packages — when the flat entry
   * exists (there is no revision to wait for).
   */
  ready: boolean;
}

export interface FrontendReadiness {
  ok: boolean;
  entries: FrontendReadinessEntry[];
  /** Packages that are not ready on this replica. */
  pending: string[];
}

const READY_FILE = '.ready';

async function packageIds(kind: FrontendReadinessKind): Promise<string[]> {
  try {
    const entries = await readdir(path.join(resolveStackPanelDataDir(), kind), {
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function inspect(kind: FrontendReadinessKind, id: string): Promise<FrontendReadinessEntry | null> {
  const packageDir = path.join(resolveStackPanelDataDir(), kind, id);
  const frontendDir = path.join(packageDir, 'frontend');
  const hasFrontend =
    existsSync(path.join(frontendDir, 'manifest.json')) ||
    existsSync(path.join(frontendDir, 'dist', 'index.js'));
  if (!hasFrontend) return null;
  const pointer = await readCurrentRevision(packageDir);
  if (!pointer || !isRevisionName(pointer.revision)) {
    // Flat-only package: no immutable revision to gate on (contract 04 §1.4
    // fallback). Readiness is simply "the flat entry is present".
    return {
      kind,
      id,
      revision: null,
      hasFrontend: true,
      ready: existsSync(path.join(frontendDir, 'dist', 'index.js')),
    };
  }
  return {
    kind,
    id,
    revision: pointer.revision,
    hasFrontend: true,
    ready: existsSync(path.join(revisionDir(packageDir, pointer.revision), READY_FILE)),
  };
}

/**
 * Snapshot the readiness of every frontend package on this replica.
 *
 * Cheap enough to run on every probe: it stats one file per package and never
 * imports anything.
 */
export async function frontendReadiness(): Promise<FrontendReadiness> {
  const entries: FrontendReadinessEntry[] = [];
  for (const kind of ['themes', 'plugins'] as const) {
    for (const id of await packageIds(kind)) {
      const entry = await inspect(kind, id);
      if (entry) entries.push(entry);
    }
  }
  const pending = entries
    .filter((entry) => !entry.ready)
    .map((entry) => `${entry.kind}:${entry.id}@${entry.revision ?? 'flat'}`);
  return { ok: pending.length === 0, entries, pending };
}
