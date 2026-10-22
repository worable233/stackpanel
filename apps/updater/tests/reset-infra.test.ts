import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLayout, type RunnerLayout } from '../src/artifact/layout.ts';
import { resetInfra } from '../src/artifact/reset-infra.ts';

/**
 * BOOTSTRAP-R6: `--reset-infra` is a narrow recovery tool, not a reinstall.
 *
 * The tests pin the four guarantees that make it safe to ship:
 * 1. only failed/never-configured phases may be reset;
 * 2. the original config is backed up before anything is touched;
 * 3. the claim token is rotated, business DSNs are dropped;
 * 4. stale candidates and queued tasks are cleared, so the path unit cannot
 *    immediately re-run a migration that was already proven broken.
 */

async function fixture(phase: string, options: { withEnv?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-reset-infra-'));
  const stateDir = path.join(root, 'state');
  const layout: RunnerLayout = resolveLayout({ root, stateDir, instanceId: 'stackpanel' });
  const bootstrapDir = path.join(stateDir, 'bootstrap');
  await mkdir(bootstrapDir, { recursive: true });

  await writeFile(
    path.join(bootstrapDir, 'state.json'),
    JSON.stringify({
      version: 1,
      phase,
      configGeneration: 3,
      targetVersion: '0.3.0',
      migrationSucceeded: phase === 'runtime_failed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    'utf8',
  );

  const envFile = path.join(stateDir, 'stackpanel.env');
  if (options.withEnv !== false) {
    await writeFile(
      envFile,
      [
        'STACKPANEL_DATA_DIR="/var/lib/stackpanel/data"',
        'JWT_SECRET="keep-me"',
        'SETTINGS_ENCRYPTION_KEY="keep-too"',
        'STACKPANEL_SETUP_TOKEN="old-token"',
        'DATABASE_URL="postgresql://u:p@h:5432/db"',
        'REDIS_URL="redis://h:6379"',
        'STORAGE_DRIVER="s3"',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  await writeFile(path.join(bootstrapDir, 'config.candidate-3.env'), 'DATABASE_URL="postgresql://bad/db"\n', 'utf8');

  const inbox = path.join(bootstrapDir, 'inbox', 'stackpanel');
  const claimed = path.join(bootstrapDir, 'claimed', 'stackpanel');
  await mkdir(inbox, { recursive: true });
  await mkdir(claimed, { recursive: true });
  await writeFile(path.join(inbox, 'task-1.json'), '{"id":"task-1"}', 'utf8');
  await writeFile(path.join(claimed, 'task-0.json'), '{"id":"task-0"}', 'utf8');

  return { root, stateDir, layout, envFile, bootstrapDir };
}

describe('resetInfra', () => {
  it('refuses completed or running instances', async () => {
    for (const phase of ['complete', 'needs_admin', 'starting', 'migrating', 'validating']) {
      const f = await fixture(phase);
      const result = await resetInfra({ layout: f.layout, log: () => {} });
      expect(result.ok, phase).toBe(false);
      expect(result.detail).toMatch(/不允许重置/);
      // Nothing was touched.
      const state = JSON.parse(
        await readFile(path.join(f.bootstrapDir, 'state.json'), 'utf8'),
      ) as { phase: string };
      expect(state.phase).toBe(phase);
      expect(await readdir(f.bootstrapDir)).toContain('config.candidate-3.env');
    }
  });

  it('backes up config, rotates the token, drops DSNs and returns to needs_infra', async () => {
    const f = await fixture('runtime_failed');
    const result = await resetInfra({
      layout: f.layout,
      log: () => {},
      generateToken: () => 'new-token-abcdef',
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/needs_infra/);
    // Migrations are explicitly not rolled back — say so.
    expect(result.detail).toMatch(/不会被回退/);

    const env = await readFile(f.envFile, 'utf8');
    expect(env).toContain('STACKPANEL_SETUP_TOKEN="new-token-abcdef"');
    expect(env).not.toContain('old-token');
    expect(env).toContain('JWT_SECRET="keep-me"');
    expect(env).toContain('SETTINGS_ENCRYPTION_KEY="keep-too"');
    expect(env).not.toContain('DATABASE_URL');
    expect(env).not.toContain('REDIS_URL');
    expect(env).not.toContain('STORAGE_DRIVER');
    expect(env).toContain('STACKPANEL_BOOTSTRAP_STATE="provision"');

    // A timestamped backup exists and still holds the old values.
    const backups = (await readdir(f.stateDir)).filter((name) => name.includes('.bak-'));
    expect(backups.length).toBe(1);
    const backup = await readFile(path.join(f.stateDir, backups[0] ?? ''), 'utf8');
    expect(backup).toContain('old-token');

    const state = JSON.parse(
      await readFile(path.join(f.bootstrapDir, 'state.json'), 'utf8'),
    ) as { phase: string; configGeneration: number; migrationSucceeded?: boolean };
    expect(state.phase).toBe('needs_infra');
    expect(state.configGeneration).toBe(0);
    // The database really did get migrated; remembering that avoids a second
    // "first migration" being attempted against an already-migrated schema.
    expect(state.migrationSucceeded).toBe(true);

    // Stale candidates and tasks are gone, so no path unit re-fires them.
    expect(await readdir(f.bootstrapDir)).not.toContain('config.candidate-3.env');
    const inbox = path.join(f.bootstrapDir, 'inbox', 'stackpanel');
    const claimed = path.join(f.bootstrapDir, 'claimed', 'stackpanel');
    expect(await readdir(inbox)).toEqual([]);
    expect(await readdir(claimed)).toEqual([]);
  });

  it('tolerates a missing env file (never configured)', async () => {
    const f = await fixture('needs_infra', { withEnv: false });
    const result = await resetInfra({
      layout: f.layout,
      log: () => {},
      generateToken: () => 'fresh-token',
    });
    expect(result.ok).toBe(true);
    const env = await readFile(f.envFile, 'utf8');
    expect(env).toContain('fresh-token');
  });

  it('refuses when there is no bootstrap state at all', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sp-reset-none-'));
    const layout = resolveLayout({
      root,
      stateDir: path.join(root, 'state'),
      instanceId: 'stackpanel',
    });
    const result = await resetInfra({ layout, log: () => {} });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/不是由 provision/);
  });

  it('refuses to parse a corrupt state file instead of guessing', async () => {
    const f = await fixture('runtime_failed');
    await writeFile(path.join(f.bootstrapDir, 'state.json'), '{oops', 'utf8');
    const result = await resetInfra({ layout: f.layout, log: () => {} });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/无法读取自举状态/);
  });
});
