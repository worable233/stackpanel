import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { frontendReadiness } from '../../src/lib/frontend-readiness.ts';

/**
 * Contract 04 §4.2 — replica readiness signal.
 *
 * The probe is what lets an orchestrator hold traffic off a replica that has
 * not finished materializing the revision it is expected to serve. These tests
 * point the data dir at a temp root and check each state.
 */

const previousDataDir = process.env.STACKPANEL_DATA_DIR;

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-ready-'));
  process.env.STACKPANEL_DATA_DIR = dir;
  return dir;
}

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.STACKPANEL_DATA_DIR;
  else process.env.STACKPANEL_DATA_DIR = previousDataDir;
});

async function writePackage(
  root: string,
  kind: 'themes' | 'plugins',
  id: string,
  options: { revision?: string; ready?: boolean; flat?: boolean },
): Promise<void> {
  const frontend = path.join(root, kind, id, 'frontend');
  await mkdir(path.join(frontend, 'dist'), { recursive: true });
  await writeFile(
    path.join(frontend, 'manifest.json'),
    JSON.stringify({ version: '1.0.0', entry: 'frontend/dist/index.js', files: [] }),
  );
  if (options.flat !== false) {
    await writeFile(path.join(frontend, 'dist', 'index.js'), 'export default {};');
  }
  if (options.revision) {
    const revisionDir = path.join(frontend, 'revisions', options.revision);
    await mkdir(revisionDir, { recursive: true });
    await writeFile(
      path.join(frontend, 'current.json'),
      JSON.stringify({ revision: options.revision, previous: null, activatedAt: '' }),
    );
    if (options.ready !== false) {
      await writeFile(path.join(revisionDir, '.ready'), 'ok\n');
    }
  }
}

describe('frontend readiness probe (contract 04 §4.2)', () => {
  it('is ready when there are no frontend packages', async () => {
    const root = await dataDir();
    try {
      const readiness = await frontendReadiness();
      expect(readiness.ok).toBe(true);
      expect(readiness.entries).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is ready when the active revision has its .ready sentinel', async () => {
    const root = await dataDir();
    try {
      await writePackage(root, 'plugins', 'demo', { revision: '0123456789ab', ready: true });
      const readiness = await frontendReadiness();
      expect(readiness.ok).toBe(true);
      expect(readiness.entries[0]).toMatchObject({
        kind: 'plugins',
        id: 'demo',
        revision: '0123456789ab',
        ready: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is degraded while a revision is still materializing', async () => {
    const root = await dataDir();
    try {
      await writePackage(root, 'themes', 't', { revision: '0123456789ab', ready: false });
      const readiness = await frontendReadiness();
      expect(readiness.ok).toBe(false);
      expect(readiness.pending).toEqual(['themes:t@0123456789ab']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats a flat-only package as ready (no revision to wait for)', async () => {
    const root = await dataDir();
    try {
      await writePackage(root, 'plugins', 'flat', { flat: true });
      const readiness = await frontendReadiness();
      expect(readiness.ok).toBe(true);
      expect(readiness.entries[0]).toMatchObject({ revision: null, ready: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores directories with no frontend at all', async () => {
    const root = await dataDir();
    try {
      await mkdir(path.join(root, 'plugins', 'backend-only'), { recursive: true });
      const readiness = await frontendReadiness();
      expect(readiness.entries).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
