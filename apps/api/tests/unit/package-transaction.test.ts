import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stageAndSwap, swapInDirectory, StagingError } from '../../src/packages/staging.ts';
import { reapTransientArtifacts, TRANSIENT_PREFIXES } from '../../src/packages/gc.ts';
import { packageManager, packageDir } from '../../src/packages/manager.ts';

const encoder = new TextEncoder();

describe('stageAndSwap', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sp-staging-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('materializes files into the target and commits', async () => {
    const target = path.join(root, 'plugins', 'demo');
    const handle = await stageAndSwap({
      parent: path.dirname(target),
      target,
      files: new Map([
        ['manifest.json', encoder.encode('{"id":"demo"}')],
        ['dist/index.js', encoder.encode('export default {}')],
      ]),
    });
    await handle.commit();
    expect(existsSync(path.join(target, 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(target, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(handle.backup)).toBe(false);
    // 暂存目录不应残留（正常路径）。
    const leftover = (await readdir(path.dirname(target))).filter((n) => n.startsWith('.stage-'));
    expect(leftover).toEqual([]);
  });

  it('rolls back to the previous package on failure', async () => {
    const target = path.join(root, 'plugins', 'demo');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'manifest.json'), 'v1');
    const handle = await stageAndSwap({
      parent: path.dirname(target),
      target,
      files: new Map([['manifest.json', encoder.encode('v2')]]),
    });
    await handle.rollback();
    expect(await readFile(path.join(target, 'manifest.json'), 'utf8')).toBe('v1');
  });

  it('rejects path traversal entries and leaves no partial target', async () => {
    const target = path.join(root, 'plugins', 'demo');
    await expect(
      stageAndSwap({
        parent: path.dirname(target),
        target,
        files: new Map([['../evil.js', encoder.encode('x')]]),
      }),
    ).rejects.toBeInstanceOf(StagingError);
    expect(existsSync(target)).toBe(false);
    const names = await readdir(path.dirname(target));
    expect(names.filter((n) => n.startsWith('.stage-'))).toEqual([]);
  });

  it('preserves the active directory until the swap succeeds', async () => {
    const target = path.join(root, 'plugins', 'demo');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'marker'), 'live');
    // 失败发生在写文件阶段（非法名），活动目录必须原封不动。
    await stageAndSwap({
      parent: path.dirname(target),
      target,
      files: new Map([['../escape', encoder.encode('x')]]),
    }).catch(() => undefined);
    expect(await readFile(path.join(target, 'marker'), 'utf8')).toBe('live');
  });
});

describe('swapInDirectory', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sp-swap-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('swaps a pre-materialized directory in and keeps the old one until commit', async () => {
    const parent = path.join(root, 'plugins');
    const target = path.join(parent, 'demo');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'manifest.json'), 'old');
    const staged = path.join(parent, '.market-demo-123');
    await mkdir(staged, { recursive: true });
    await writeFile(path.join(staged, 'manifest.json'), 'new');

    const handle = await swapInDirectory({ parent, target, sourceDir: staged });
    expect(await readFile(path.join(target, 'manifest.json'), 'utf8')).toBe('new');
    expect(existsSync(handle.backup)).toBe(true);
    await handle.commit();
    expect(existsSync(handle.backup)).toBe(false);
  });

  it('restores the previous directory on rollback', async () => {
    const parent = path.join(root, 'plugins');
    const target = path.join(parent, 'demo');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'manifest.json'), 'old');
    const staged = path.join(parent, '.market-demo-123');
    await mkdir(staged, { recursive: true });
    await writeFile(path.join(staged, 'manifest.json'), 'new');

    const handle = await swapInDirectory({ parent, target, sourceDir: staged });
    await handle.rollback();
    expect(await readFile(path.join(target, 'manifest.json'), 'utf8')).toBe('old');
  });
});

describe('reapTransientArtifacts', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sp-gc-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes only aged transient dirs and never the active package', async () => {
    const active = path.join(root, 'demo');
    await mkdir(active, { recursive: true });
    for (const prefix of TRANSIENT_PREFIXES) {
      await mkdir(path.join(root, `${prefix}demo-123`), { recursive: true });
    }
    const freshStage = path.join(root, '.stage-demo-fresh');
    await mkdir(freshStage, { recursive: true });

    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const prefix of TRANSIENT_PREFIXES) {
      await utimes(path.join(root, `${prefix}demo-123`), old, old);
    }

    const reaped = await reapTransientArtifacts(root, { maxAgeMs: 60 * 60 * 1000 });
    expect(reaped.sort()).toEqual(TRANSIENT_PREFIXES.map((p) => `${p}demo-123`).sort());
    // 活动目录与新鲜暂存目录都保留。
    expect(existsSync(active)).toBe(true);
    expect(existsSync(freshStage)).toBe(true);
  });

  it('never touches directories that are not a known transient prefix', async () => {
    const keep = path.join(root, '.seed-demo-1');
    await mkdir(keep, { recursive: true });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(keep, old, old);
    const reaped = await reapTransientArtifacts(root, { maxAgeMs: 60 * 60 * 1000 });
    expect(reaped).toEqual([]);
    expect(existsSync(keep)).toBe(true);
  });
});

describe('PackageManager facade', () => {
  let dataDir: string;
  let previous: string | undefined;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'sp-manager-'));
    previous = process.env['STACKPANEL_DATA_DIR'];
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env['STACKPANEL_DATA_DIR'];
    else process.env['STACKPANEL_DATA_DIR'] = previous;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('resolves plugin and theme dirs under the data dir', () => {
    expect(packageDir('plugin', 'demo')).toBe(path.join(dataDir, 'plugins', 'demo'));
    expect(packageDir('theme', 'default')).toBe(path.join(dataDir, 'themes', 'default'));
    expect(packageManager.plan('plugin', 'demo').parent).toBe(path.join(dataDir, 'plugins'));
    expect(packageManager.plan('theme', 'default').parent).toBe(path.join(dataDir, 'themes'));
  });

  it('stages files for a plugin and commits', async () => {
    const handle = await packageManager.stageFiles(
      'plugin',
      'demo',
      new Map([['manifest.json', encoder.encode('{}')]]),
      {
        prepareStage: async (stage) => {
          await mkdir(path.join(stage, 'dist'), { recursive: true });
        },
      },
    );
    await handle.commit();
    expect(existsSync(path.join(dataDir, 'plugins', 'demo', 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(dataDir, 'plugins', 'demo', 'dist'))).toBe(true);
  });

  it('reclaims only unreferenced transient artifacts for a kind', async () => {
    const parent = path.join(dataDir, 'plugins');
    await mkdir(path.join(parent, '.backup-demo-old'), { recursive: true });
    await mkdir(path.join(parent, 'demo'), { recursive: true });
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(path.join(parent, '.backup-demo-old'), old, old);
    const reaped = await packageManager.gc('plugin', { maxAgeMs: 60 * 60 * 1000 });
    expect(reaped).toEqual(['.backup-demo-old']);
    expect(existsSync(path.join(parent, 'demo'))).toBe(true);
  });

  it('gcAll reaps both plugin and theme parents', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const kind of ['plugins', 'themes'] as const) {
      const dir = path.join(dataDir, kind, '.stage-old');
      await mkdir(dir, { recursive: true });
      await utimes(dir, old, old);
    }
    const result = await packageManager.gcAll({ maxAgeMs: 60 * 60 * 1000 });
    expect(result.plugins).toEqual(['.stage-old']);
    expect(result.themes).toEqual(['.stage-old']);
    // 目录被删除后不应再存在。
    expect(existsSync(path.join(dataDir, 'plugins', '.stage-old'))).toBe(false);
    expect(await stat(path.join(dataDir, 'themes'))).toBeTruthy();
  });
});
