import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markAdminClaimed } from '../../src/bootstrap/claim-state.ts';
import { BootstrapStateStore } from '../../src/bootstrap/state.ts';

/**
 * BOOTSTRAP-R4: the phase becomes `complete` only after the first admin exists.
 * These tests pin the narrowness of that transition — it must not turn a
 * half-installed instance into a "complete" one just because someone claimed.
 */

const savedStateDir = process.env.STACKPANEL_STATE_DIR;
const savedDataDir = process.env.STACKPANEL_DATA_DIR;

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.STACKPANEL_STATE_DIR;
  else process.env.STACKPANEL_STATE_DIR = savedStateDir;
  if (savedDataDir === undefined) delete process.env.STACKPANEL_DATA_DIR;
  else process.env.STACKPANEL_DATA_DIR = savedDataDir;
});

async function instance(phase: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-claim-'));
  process.env.STACKPANEL_STATE_DIR = root;
  delete process.env.STACKPANEL_DATA_DIR;
  const dir = path.join(root, 'bootstrap');
  const store = new BootstrapStateStore({ dir, targetVersion: '0.3.0' });
  await store.write({
    version: 1,
    phase: phase as never,
    configGeneration: 1,
    migrationSucceeded: true,
    runtimeReady: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { root, dir, store };
}

describe('markAdminClaimed', () => {
  it('advances needs_admin to complete and records the claim', async () => {
    const { store } = await instance('needs_admin');
    await markAdminClaimed(() => {});
    expect(await store.read()).toMatchObject({
      phase: 'complete',
      adminClaimed: true,
      migrationSucceeded: true,
      runtimeReady: true,
    });
  });

  it('is idempotent', async () => {
    const { dir, store } = await instance('needs_admin');
    await markAdminClaimed(() => {});
    await markAdminClaimed(() => {});
    const state = await store.read();
    expect(state?.phase).toBe('complete');
    // Only one state file — no stray generations or side files.
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((n) => n.startsWith('state'))).toEqual(['state.json']);
  });

  it('does not rewrite an instance that never reached needs_admin', async () => {
    const { store } = await instance('runtime_failed');
    const messages: string[] = [];
    await markAdminClaimed((message) => messages.push(message));
    expect((await store.read())?.phase).toBe('runtime_failed');
    expect(messages.join('\n')).toMatch(/未自动推进/);
  });

  it('never throws when the state file is unreadable', async () => {
    const { dir } = await instance('needs_admin');
    await writeFile(path.join(dir, 'state.json'), '{not json', 'utf8');
    // A claim must not fail because bookkeeping is broken.
    await expect(markAdminClaimed(() => {})).resolves.toBeUndefined();
    expect(await readFile(path.join(dir, 'state.json'), 'utf8')).toBe('{not json');
  });

  it('does nothing when the instance has no bootstrap state at all', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sp-claim-none-'));
    process.env.STACKPANEL_STATE_DIR = root;
    await expect(markAdminClaimed(() => {})).resolves.toBeUndefined();
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(root)).toEqual([]);
  });

  it('derives the state dir from STACKPANEL_DATA_DIR when the explicit root is absent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sp-claim-data-'));
    delete process.env.STACKPANEL_STATE_DIR;
    process.env.STACKPANEL_DATA_DIR = path.join(root, 'data');
    const store = new BootstrapStateStore({
      dir: path.join(root, 'bootstrap'),
      targetVersion: '0.3.0',
    });
    await store.write({
      version: 1,
      phase: 'needs_admin',
      configGeneration: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await markAdminClaimed(() => {});
    expect((await store.read())?.phase).toBe('complete');
  });
});

void vi;
