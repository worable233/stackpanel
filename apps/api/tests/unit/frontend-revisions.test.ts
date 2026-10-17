import { describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  activateRevision,
  computeRevisionDigest,
  ensureCurrentRevision,
  isRevisionName,
  listRevisions,
  materializeFromPackageDir,
  materializeRevision,
  preserveRevisions,
  pruneRevisions,
  readCurrentRevision,
  resolveRevisionAsset,
  revisionDir,
} from '../../src/lib/frontend-revisions.ts';
import { validateFrontendFiles } from '../../src/lib/frontend.ts';

/**
 * Contract 04 — versioned, content-addressed asset service (§1/§2/§4/§7).
 *
 * Covers: digest stability/coverage, immutable materialization + dedup, atomic
 * activation, single-request version pinning via `resolveRevisionAsset`,
 * retention pruning, and the "ensure" fallback used by the descriptor.
 */

function frontendFiles(
  js: string,
  css: string,
  manifest: Record<string, unknown>,
): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ['frontend/manifest.json', strToU8(JSON.stringify(manifest))],
    ['frontend/dist/index.js', strToU8(js)],
    ['frontend/dist/index.css', strToU8(css)],
  ]);
}

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0.0',
    revision: '',
    entry: 'frontend/dist/index.js',
    files: ['frontend/dist/index.js', 'frontend/dist/index.css'],
    ...overrides,
  };
}

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'sp-rev-'));
}

describe('revision name safety', () => {
  it('accepts hex digests and rejects traversal', () => {
    expect(isRevisionName('0123456789ab')).toBe(true);
    expect(isRevisionName('ABCDEF')).toBe(false);
    expect(isRevisionName('../evil')).toBe(false);
    expect(isRevisionName('short')).toBe(false);
  });
});

describe('computeRevisionDigest (contract 04 §1.2)', () => {
  it('is stable for identical bytes and independent of the manifest revision field', () => {
    const a = frontendFiles('export default 1;', '.x{}', baseManifest({ revision: '' }));
    const b = frontendFiles('export default 1;', '.x{}', baseManifest({ revision: 'ignored' }));
    const manifestA = validateFrontendFiles(a);
    const manifestB = validateFrontendFiles(b);
    expect(computeRevisionDigest(manifestA, a)).toBe(computeRevisionDigest(manifestB, b));
  });

  it('changes when any shipped byte changes (covers CSS too)', () => {
    const a = frontendFiles('export default 1;', '.x{color:red}', baseManifest({ styles: [] }));
    const b = frontendFiles('export default 1;', '.x{color:blue}', baseManifest({ styles: [] }));
    expect(computeRevisionDigest(validateFrontendFiles(a), a)).not.toBe(
      computeRevisionDigest(validateFrontendFiles(b), b),
    );
  });

  it('changes when the manifest body changes', () => {
    const a = frontendFiles('export default 1;', '.x{}', baseManifest());
    const b = frontendFiles(
      'export default 1;',
      '.x{}',
      baseManifest({
        pages: [{ path: '/x', component: 'X' }],
      }),
    );
    expect(computeRevisionDigest(validateFrontendFiles(a), a)).not.toBe(
      computeRevisionDigest(validateFrontendFiles(b), b),
    );
  });
});

describe('materializeRevision + activation (contract 04 §4)', () => {
  it('writes an immutable revision dir with .ready and activates it atomically', async () => {
    const dir = await tmp();
    try {
      const files = frontendFiles('export default 1;', '.x{}', baseManifest());
      const result = await materializeRevision(dir, files, { activate: true });
      expect(isRevisionName(result.revision)).toBe(true);
      expect(result.activated).toBe(true);
      expect(result.reused).toBe(false);
      const current = await readCurrentRevision(dir);
      expect(current?.revision).toBe(result.revision);
      const asset = resolveRevisionAsset(dir, result.revision, 'dist/index.js');
      expect(asset).not.toBeNull();
      expect(await readFile(asset ?? '', 'utf8')).toBe('export default 1;');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('deduplicates identical bytes (idempotent, no rewrite)', async () => {
    const dir = await tmp();
    try {
      const files = frontendFiles('export default 1;', '.x{}', baseManifest());
      const first = await materializeRevision(dir, files, { activate: true });
      const second = await materializeRevision(dir, files, { activate: true });
      expect(second.revision).toBe(first.revision);
      expect(second.reused).toBe(true);
      expect((await listRevisions(dir)).length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records the previous revision when switching versions', async () => {
    const dir = await tmp();
    try {
      const first = await materializeRevision(
        dir,
        frontendFiles('export default 1;', '.x{}', baseManifest()),
        { activate: true },
      );
      const second = await materializeRevision(
        dir,
        frontendFiles('export default 2;', '.x{}', baseManifest()),
        { activate: true },
      );
      expect(second.revision).not.toBe(first.revision);
      const current = await readCurrentRevision(dir);
      expect(current?.revision).toBe(second.revision);
      expect(current?.previous).toBe(first.revision);
      // Old revision still resolvable (open tabs keep working, §7).
      expect(resolveRevisionAsset(dir, first.revision, 'dist/index.js')).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects activating an unsafe revision name', async () => {
    const dir = await tmp();
    try {
      await expect(activateRevision(dir, '../evil')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveRevisionAsset (single-request version pinning, contract 04 §3)', () => {
  it('rejects traversal inside a revision and unknown revisions', async () => {
    const dir = await tmp();
    try {
      const { revision } = await materializeRevision(
        dir,
        frontendFiles('export default 1;', '.x{}', baseManifest()),
        { activate: true },
      );
      expect(resolveRevisionAsset(dir, revision, '../manifest.json')).toBeNull();
      expect(resolveRevisionAsset(dir, revision, 'dist/../../etc/passwd')).toBeNull();
      expect(resolveRevisionAsset(dir, '../evil', 'dist/index.js')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ensureCurrentRevision (descriptor fallback for build:frontend)', () => {
  it('materializes a flat frontend that has no revision yet', async () => {
    const dir = await tmp();
    try {
      await mkdir(path.join(dir, 'frontend', 'dist'), { recursive: true });
      await writeFile(
        path.join(dir, 'frontend', 'manifest.json'),
        JSON.stringify(baseManifest({ revision: 'build-script-value' })),
      );
      await writeFile(path.join(dir, 'frontend', 'dist', 'index.js'), 'export default 1;');
      await writeFile(path.join(dir, 'frontend', 'dist', 'index.css'), '.x{}');
      expect(await readCurrentRevision(dir)).toBeNull();
      const result = await ensureCurrentRevision(dir);
      expect(result).not.toBeNull();
      expect((await readCurrentRevision(dir))?.revision).toBe(result?.revision);
      // Second call is a cheap reuse.
      const again = await ensureCurrentRevision(dir);
      expect(again?.reused).toBe(true);
      expect(again?.revision).toBe(result?.revision);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when there is no flat frontend', async () => {
    const dir = await tmp();
    try {
      expect(await ensureCurrentRevision(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('materializeFromPackageDir', () => {
  it('publishes an extracted flat frontend to a revision', async () => {
    const dir = await tmp();
    try {
      await mkdir(path.join(dir, 'frontend', 'dist'), { recursive: true });
      await writeFile(path.join(dir, 'frontend', 'manifest.json'), JSON.stringify(baseManifest()));
      await writeFile(path.join(dir, 'frontend', 'dist', 'index.js'), 'export default 1;');
      await writeFile(path.join(dir, 'frontend', 'dist', 'index.css'), '.x{}');
      const result = await materializeFromPackageDir(dir, { activate: true });
      expect(result).not.toBeNull();
      expect((await readCurrentRevision(dir))?.revision).toBe(result?.revision);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('preserveRevisions (contract 04 §7 upgrade retention)', () => {
  it('copies a prior revision into a freshly written package dir', async () => {
    const from = await tmp();
    const to = await tmp();
    try {
      const { revision } = await materializeRevision(
        from,
        frontendFiles('export default 1;', '.x{}', baseManifest()),
        { activate: true },
      );
      const copied = await preserveRevisions(from, to);
      expect(copied).toBe(1);
      // The old revision now resolves from the new package dir.
      const asset = resolveRevisionAsset(to, revision, 'dist/index.js');
      expect(asset).not.toBeNull();
      expect(await readFile(asset ?? '', 'utf8')).toBe('export default 1;');
      // Idempotent: a second call copies nothing.
      expect(await preserveRevisions(from, to)).toBe(0);
    } finally {
      await rm(from, { recursive: true, force: true });
      await rm(to, { recursive: true, force: true });
    }
  });
});

describe('pruneRevisions (contract 04 §7)', () => {
  it('keeps the current revision and the newest N, evicting older ones', async () => {
    const dir = await tmp();
    try {
      // Publish 4 revisions, each with a distinct byte. Force createdAt to be
      // old so the age window does not retain them.
      const revisions: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const result = await materializeRevision(
          dir,
          frontendFiles(`export default ${i};`, '.x{}', baseManifest()),
          { activate: true },
        );
        revisions.push(result.revision);
      }
      const current = revisions[revisions.length - 1];
      const removed = await pruneRevisions(dir, { retainCount: 2, retainMs: 0 });
      expect(removed.length).toBeGreaterThan(0);
      expect(removed).not.toContain(current);
      const remaining = await listRevisions(dir);
      expect(remaining.length).toBe(2);
      expect(remaining.map((r) => r.revision)).toContain(current);
      // Every remaining directory is still fully materialized.
      for (const record of remaining) {
        expect(record.ready).toBe(true);
        expect(resolveRevisionAsset(dir, record.revision, 'dist/index.js')).not.toBeNull();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('revisionDir layout', () => {
  it('places revisions under frontend/revisions/<rev>', async () => {
    const dir = await tmp();
    try {
      const { revision } = await materializeRevision(
        dir,
        frontendFiles('export default 1;', '.x{}', baseManifest()),
        { activate: true },
      );
      expect(revisionDir(dir, revision)).toBe(
        path.join(dir, 'frontend', 'revisions', revision),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
