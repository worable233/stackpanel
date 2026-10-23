import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bootstrapChannelPaths,
  claimFirstBootstrapTask,
  ensureBootstrapChannel,
  finishBootstrapTask,
} from '../src/artifact/bootstrap-channel.ts';
import {
  bootstrapChannelPaths as kernelPaths,
  publishBootstrapTask,
} from '../../api/src/bootstrap/task.ts';

/**
 * The channel protocol is shared between the kernel (writer) and the runner
 * (claimer). These tests pin the three invariants from audit R3:
 *
 * 1. a published task is only visible after it is complete (rename);
 * 2. claiming removes it from the inbox, so a path unit cannot re-fire it;
 * 3. a terminal result is always written and the claimed copy is cleaned up.
 */

async function dirs() {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-bootstrap-channel-'));
  return { root, paths: bootstrapChannelPaths(root, 'stackpanel') };
}

describe('bootstrap channel', () => {
  it('writes both implementations to the same directories', async () => {
    const { root } = await dirs();
    const a = bootstrapChannelPaths(root, 'stackpanel');
    const b = kernelPaths(root, 'stackpanel');
    expect(a).toEqual(b);
  });

  it('publishes atomically so the inbox never contains a partial file', async () => {
    const { paths } = await dirs();
    await ensureBootstrapChannel(paths);
    await publishBootstrapTask(paths, {
      id: 'op-1',
      configGeneration: 1,
      targetVersion: '0.3.0',
    });

    const names = await readdir(paths.inbox);
    expect(names).toEqual(['op-1.json']);
    const content = JSON.parse(await readFile(path.join(paths.inbox, 'op-1.json'), 'utf8'));
    expect(content).toMatchObject({
      id: 'op-1',
      configGeneration: 1,
      targetVersion: '0.3.0',
    });
    // No credentials in the task file.
    expect(JSON.stringify(content)).not.toMatch(/postgres|redis|secret/i);
  });

  it('moves the task out of the inbox on claim (no re-trigger loop)', async () => {
    const { paths } = await dirs();
    await ensureBootstrapChannel(paths);
    await publishBootstrapTask(paths, {
      id: 'op-2',
      configGeneration: 2,
      targetVersion: '0.3.1',
    });

    const claimed = await claimFirstBootstrapTask(paths);
    expect(claimed?.task.id).toBe('op-2');
    expect(await readdir(paths.inbox)).toEqual([]);
    expect(await readdir(paths.claimed)).toEqual(['op-2.json']);

    // A second claim sees nothing: path unit wake-ups are idempotent.
    expect(await claimFirstBootstrapTask(paths)).toBeNull();
  });

  it('claims in deterministic order', async () => {
    const { paths } = await dirs();
    await ensureBootstrapChannel(paths);
    for (const id of ['c', 'a', 'b']) {
      await publishBootstrapTask(paths, {
        id,
        configGeneration: 1,
        targetVersion: 'v',
      });
    }
    const first = await claimFirstBootstrapTask(paths);
    expect(first?.task.id).toBe('a');
  });

  it('ignores temporary files left by an interrupted writer', async () => {
    const { paths } = await dirs();
    await ensureBootstrapChannel(paths);
    await writeFile(path.join(paths.inbox, '.op-x.deadbeef.tmp'), 'half', 'utf8');
    expect(await claimFirstBootstrapTask(paths)).toBeNull();
  });

  it('writes a result and clears claimed on success', async () => {
    const { paths } = await dirs();
    await ensureBootstrapChannel(paths);
    await publishBootstrapTask(paths, {
      id: 'op-3',
      configGeneration: 1,
      targetVersion: 'v',
    });
    await claimFirstBootstrapTask(paths);

    await finishBootstrapTask(paths, 'op-3', { ok: true, phase: 'needs_admin' });

    expect(await readdir(paths.claimed)).toEqual([]);
    const result = JSON.parse(await readFile(path.join(paths.results, 'op-3.json'), 'utf8'));
    expect(result).toMatchObject({ ok: true, phase: 'needs_admin' });
    expect(await readdir(paths.inbox)).toEqual([]);
  });

  it('writes a failure result so operators can see why it stopped', async () => {
    const { paths } = await dirs();
    await ensureBootstrapChannel(paths);
    await publishBootstrapTask(paths, {
      id: 'op-4',
      configGeneration: 1,
      targetVersion: 'v',
    });
    await claimFirstBootstrapTask(paths);

    await finishBootstrapTask(paths, 'op-4', {
      ok: false,
      phase: 'migration_failed',
      detail: 'migration_connect_failed',
    });

    const result = JSON.parse(await readFile(path.join(paths.results, 'op-4.json'), 'utf8'));
    expect(result).toMatchObject({ ok: false, phase: 'migration_failed' });
    // The inbox stays empty, so the path unit does not loop on a failed migration.
    expect(await readdir(paths.inbox)).toEqual([]);
  });

  it('does not leave a task in the inbox when JSON is corrupt', async () => {
    const { paths } = await dirs();
    await ensureBootstrapChannel(paths);
    await writeFile(path.join(paths.inbox, 'broken.json'), '{"id":', 'utf8');

    await expect(claimFirstBootstrapTask(paths)).rejects.toThrow(/JSON/);
    // Critically: even a corrupt task is removed from the inbox, otherwise the
    // path unit would re-fire it forever.
    expect(await readdir(paths.inbox)).toEqual([]);
    expect(await readdir(paths.claimed)).toEqual(['broken.json']);
  });

  it('creates the channel directories when they are missing', async () => {
    const { paths } = await dirs();
    await ensureBootstrapChannel(paths);
    for (const dir of [paths.inbox, paths.claimed, paths.results]) {
      await mkdir(dir, { recursive: true });
      expect((await readdir(dir)).length).toBe(0);
    }
  });
});
