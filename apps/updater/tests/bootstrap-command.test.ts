import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandRequest, CommandResult, CommandRunner } from '../src/command.ts';
import { CommandError } from '../src/command.ts';
import { resolveLayout, type RunnerLayout } from '../src/artifact/layout.ts';
import { bootstrapCommand } from '../src/artifact/bootstrap-command.ts';
import { bootstrapChannelPaths } from '../src/artifact/bootstrap-channel.ts';
import { mkdir as makeDir, writeFile as write } from 'node:fs/promises';

/** Write a task file the way the API does: temp + rename into inbox. */
async function publishTask(
  channel: ReturnType<typeof bootstrapChannelPaths>,
  task: { id: string; configGeneration: number; targetVersion: string },
): Promise<void> {
  await makeDir(channel.inbox, { recursive: true });
  const target = path.join(channel.inbox, `${task.id}.json`);
  const temp = `${target}.tmp`;
  await write(
    temp,
    JSON.stringify({ version: 1, createdAt: new Date().toISOString(), ...task }),
    'utf8',
  );
  const { rename } = await import('node:fs/promises');
  await rename(temp, target);
}

/**
 * BOOTSTRAP-R3: the CLI bridge is the only thing systemd calls. The tests pin
 * the parts that turn "a task file exists" into "exactly one execution":
 *
 * - a task is claimed out of inbox before it runs (no re-trigger loop);
 * - the result is always written, success or failure;
 * - an empty inbox is not an error, but an interrupted `queued`/`migrating`/
 *   `starting` state is recovered instead of being left forever;
 * - a busy instance lock leaves the task in inbox for the next wake-up.
 */

class FakeRunner implements CommandRunner {
  readonly calls: CommandRequest[] = [];
  constructor(private readonly failMigration = false) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    if (this.failMigration && request.args.some((arg) => arg.endsWith('migrate.mjs'))) {
      throw new CommandError('boom', { code: 1, stdout: '', stderr: 'boom' });
    }
    if (request.args.includes('jlist')) {
      return { code: 0, stdout: JSON.stringify([{ name: 'stackpanel-worker', pm2_env: { status: 'online' } }]), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  migrationCalls(): CommandRequest[] {
    return this.calls.filter((call) => call.args.some((arg) => arg.endsWith('migrate.mjs')));
  }
}

const VERSION = '0.3.0';

async function fixture(phase: RunnerBootstrapState['phase'], withTask: boolean) {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-bootstrap-command-'));
  const stateDir = path.join(root, 'state');
  const layout: RunnerLayout = resolveLayout({ root, stateDir, instanceId: 'stackpanel' });
  // The executor lock lives under `<state>/update`; the installer creates it.
  await mkdir(layout.updateDir, { recursive: true });

  // Release + migrate bundles (minimal but complete enough for the guards).
  const releaseDir = path.join(layout.releasesDir, VERSION);
  await mkdir(releaseDir, { recursive: true });
  await writeFile(
    path.join(releaseDir, 'RELEASE.json'),
    JSON.stringify({
      version: VERSION,
      role: 'kernel',
      platform: 'linux-x64',
      nodeMajor: Number(process.versions.node.split('.')[0]),
    }),
    'utf8',
  );
  await writeFile(path.join(releaseDir, 'ecosystem.config.cjs'), 'module.exports={apps:[]}', 'utf8');
  const { symlink } = await import('node:fs/promises');
  await symlink(releaseDir, layout.currentLink);

  const migrateDir = path.join(root, 'migrate', VERSION);
  await mkdir(path.join(migrateDir, 'prisma', 'migrations'), { recursive: true });
  await mkdir(path.join(migrateDir, 'node_modules', 'prisma', 'build'), { recursive: true });
  for (const [file, content] of [
    ['migrate.mjs', '// migrate'],
    ['prisma.config.mjs', 'export default {}'],
    [path.join('prisma', 'schema.prisma'), 'datasource db {}'],
    [path.join('node_modules', 'prisma', 'build', 'index.js'), '// cli'],
    [
      'RELEASE.json',
      JSON.stringify({
        version: VERSION,
        role: 'migrate',
        platform: 'linux-x64',
        nodeMajor: Number(process.versions.node.split('.')[0]),
      }),
    ],
  ] as Array<[string, string]>) {
    await writeFile(path.join(migrateDir, file), content, 'utf8');
  }

  const bootstrapDir = path.join(stateDir, 'bootstrap');
  await mkdir(bootstrapDir, { recursive: true });
  await writeFile(
    path.join(bootstrapDir, 'state.json'),
    JSON.stringify({
      version: 1,
      phase,
      configGeneration: 1,
      targetVersion: VERSION,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  await writeFile(
    path.join(bootstrapDir, 'config.candidate-1.env'),
    'DATABASE_URL="postgresql://u:p@h:5432/db"\n',
    'utf8',
  );
  await writeFile(
    path.join(stateDir, 'stackpanel.env'),
    'JWT_SECRET="keep"\nSTACKPANEL_SETUP_TOKEN="tok"\n',
    'utf8',
  );

  const channel = bootstrapChannelPaths(stateDir, 'stackpanel');
  if (withTask) {
    await publishTask(channel, { id: 'task-1', configGeneration: 1, targetVersion: VERSION });
  }
  return { root, stateDir, layout, channel, bootstrapDir };
}

type RunnerBootstrapState = { phase: string };

function options(f: Awaited<ReturnType<typeof fixture>>, runner: FakeRunner) {
  return {
    layout: f.layout,
    runner,
    probe: async () => true,
    now: () => new Date(),
    log: () => {},
  };
}

describe('bootstrapCommand', () => {
  it('claims the task out of inbox, runs it once, and writes a result', async () => {
    const f = await fixture('queued', true);
    const runner = new FakeRunner();

    await expect(bootstrapCommand(options(f, runner))).resolves.toBe(0);

    expect(runner.migrationCalls()).toHaveLength(1);
    // Claimed before execution: a failing path unit must not re-fire the same
    // migration forever (that is the loop the audit calls out).
    expect(await readdir(f.channel.inbox)).toEqual([]);
    expect(await readdir(f.channel.claimed)).toEqual([]);
    const results = await readdir(f.channel.results);
    expect(results).toEqual(['task-1.json']);
    const result = JSON.parse(await readFile(path.join(f.channel.results, 'task-1.json'), 'utf8'));
    expect(result).toMatchObject({ id: 'task-1', ok: true, phase: 'needs_admin' });
  });

  it('writes a failed result and still clears the channel on migration failure', async () => {
    const f = await fixture('queued', true);
    const runner = new FakeRunner(true);

    await expect(bootstrapCommand(options(f, runner))).resolves.toBe(1);

    expect(await readdir(f.channel.inbox)).toEqual([]);
    expect(await readdir(f.channel.claimed)).toEqual([]);
    const result = JSON.parse(await readFile(path.join(f.channel.results, 'task-1.json'), 'utf8'));
    expect(result).toMatchObject({ ok: false, phase: 'migration_failed' });
    expect(result.detail).toContain('migration_');
  });

  it('returns 0 with an empty inbox and a settled phase (idempotent wake-up)', async () => {
    for (const phase of ['needs_infra', 'needs_admin', 'complete', 'runtime_failed']) {
      const f = await fixture(phase, false);
      const runner = new FakeRunner();
      await expect(bootstrapCommand(options(f, runner)), phase).resolves.toBe(0);
      expect(runner.migrationCalls()).toEqual([]);
      expect(runner.calls).toEqual([]);
    }
  });

  it('recovers `queued` when the task file was never written', async () => {
    const f = await fixture('queued', false);
    const runner = new FakeRunner();
    await expect(bootstrapCommand(options(f, runner))).resolves.toBe(0);
    expect(runner.migrationCalls()).toHaveLength(1);
    const state = JSON.parse(await readFile(path.join(f.bootstrapDir, 'state.json'), 'utf8'));
    expect(state.phase).toBe('needs_admin');
  });

  it('recovers `migrating` by re-running the idempotent migration', async () => {
    const f = await fixture('migrating', false);
    const runner = new FakeRunner();
    await expect(bootstrapCommand(options(f, runner))).resolves.toBe(0);
    expect(runner.migrationCalls()).toHaveLength(1);
    const state = JSON.parse(await readFile(path.join(f.bootstrapDir, 'state.json'), 'utf8'));
    expect(state.phase).toBe('needs_admin');
  });

  it('recovers `starting` without re-running the migration', async () => {
    const f = await fixture('starting', false);
    const runner = new FakeRunner();
    await expect(bootstrapCommand(options(f, runner))).resolves.toBe(0);
    expect(runner.migrationCalls()).toEqual([]);
    const state = JSON.parse(await readFile(path.join(f.bootstrapDir, 'state.json'), 'utf8'));
    expect(state.phase).toBe('needs_admin');
  });

  it('leaves the task in inbox when another executor holds the lock', async () => {
    const f = await fixture('queued', true);
    // Simulate a live lock owned by another pid.
    const { ExecutorLock } = await import('../src/executor-lock.ts');
    const other = new ExecutorLock({
      filePath: f.layout.lockFile,
      owner: `other-host:${process.pid + 100000}`,
      now: () => new Date(),
    });
    await other.acquire();

    const runner = new FakeRunner();
    await expect(bootstrapCommand(options(f, runner))).resolves.toBe(0);
    expect(runner.calls).toEqual([]);
    // The next wake-up must still see the task.
    expect(await readdir(f.channel.inbox)).toEqual(['task-1.json']);
    await other.release();
  });

  it('refuses to run a task whose target version disagrees with disk', async () => {
    const f = await fixture('queued', false);
    await publishTask(f.channel, { id: 'task-bad', configGeneration: 1, targetVersion: '9.9.9' });
    const runner = new FakeRunner();
    await expect(bootstrapCommand(options(f, runner))).resolves.toBe(1);
    expect(runner.migrationCalls()).toEqual([]);
    const result = JSON.parse(
      await readFile(path.join(f.channel.results, 'task-bad.json'), 'utf8'),
    );
    expect(result.detail).toContain('不一致');
  });
});
