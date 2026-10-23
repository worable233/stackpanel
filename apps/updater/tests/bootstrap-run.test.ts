import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandRequest, CommandResult, CommandRunner } from '../src/command.ts';
import { CommandError } from '../src/command.ts';
import { resolveLayout, type RunnerLayout } from '../src/artifact/layout.ts';
import {
  assertBundleMatchesKernel,
  assertMigrateBundleComplete,
  classifyMigrationError,
  readBootstrapState,
  runBootstrap,
  type RunnerBootstrapState,
} from '../src/artifact/bootstrap.ts';

/** A fake runner that records every command and can fail the migration. */
class FakeRunner implements CommandRunner {
  readonly calls: CommandRequest[] = [];
  constructor(
    private readonly behaviour: {
      failMigrate?: string;
      apiReady?: boolean;
      webReady?: boolean;
      workerOnline?: boolean;
    } = {},
  ) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    const isMigrate = request.args.some((arg) => arg.endsWith('migrate.mjs'));
    if (isMigrate && this.behaviour.failMigrate) {
      throw new CommandError(this.behaviour.failMigrate, {
        code: 1,
        stdout: '',
        stderr: this.behaviour.failMigrate,
      });
    }
    if (request.args.includes('jlist')) {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            name: 'stackpanel-worker',
            pm2_env: { status: this.behaviour.workerOnline === false ? 'errored' : 'online' },
          },
        ]),
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  }

  migrationCall(): CommandRequest | undefined {
    return this.calls.find((call) => call.args.some((arg) => arg.endsWith('migrate.mjs')));
  }

  pm2Calls(): CommandRequest[] {
    return this.calls.filter((call) => call.file === 'pm2' || call.args.includes('start'));
  }
}

async function fixture(options: {
  phase?: RunnerBootstrapState['phase'];
  generation?: number;
  missingFile?: string;
  kernelVersion?: string;
  migrateVersion?: string;
  nodeMajor?: number;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sp-bootstrap-run-'));
  const stateDir = path.join(root, 'state');
  const layout: RunnerLayout = resolveLayout({ root, stateDir, instanceId: 'stackpanel' });

  const version = options.kernelVersion ?? '0.3.0';
  const generation = options.generation ?? 1;

  // release with RELEASE.json + ecosystem
  const releaseDir = path.join(layout.releasesDir, version);
  await mkdir(releaseDir, { recursive: true });
  await writeFile(
    path.join(releaseDir, 'RELEASE.json'),
    JSON.stringify({
      version,
      role: 'kernel',
      platform: 'linux-x64',
      nodeMajor: options.nodeMajor ?? Number(process.versions.node.split('.')[0]),
    }),
    'utf8',
  );
  await writeFile(path.join(releaseDir, 'ecosystem.config.cjs'), 'module.exports={apps:[]}', 'utf8');
  await mkdir(layout.releasesDir, { recursive: true });
  const { symlink } = await import('node:fs/promises');
  await symlink(releaseDir, layout.currentLink).catch(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(layout.currentLink, { force: true });
    await symlink(releaseDir, layout.currentLink);
  });

  // migrate bundle
  const migrateDir = path.join(root, 'migrate', version);
  await mkdir(path.join(migrateDir, 'prisma'), { recursive: true });
  await mkdir(path.join(migrateDir, 'node_modules', 'prisma', 'build'), { recursive: true });
  const required: Array<[string, string]> = [
    ['migrate.mjs', '// migrate'],
    ['prisma.config.mjs', 'export default {}'],
    [path.join('prisma', 'schema.prisma'), 'datasource db {}'],
    [path.join('node_modules', 'prisma', 'build', 'index.js'), '// cli'],
    [
      'RELEASE.json',
      JSON.stringify({
        version: options.migrateVersion ?? version,
        role: 'migrate',
        platform: 'linux-x64',
        nodeMajor: options.nodeMajor ?? Number(process.versions.node.split('.')[0]),
      }),
    ],
  ];
  for (const [file, content] of required) {
    if (file === options.missingFile) continue;
    await writeFile(path.join(migrateDir, file), content, 'utf8');
  }

  // bootstrap state + candidate
  const bootstrapDir = path.join(stateDir, 'bootstrap');
  await mkdir(bootstrapDir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    path.join(bootstrapDir, 'state.json'),
    JSON.stringify({
      version: 1,
      phase: options.phase ?? 'queued',
      configGeneration: generation,
      targetVersion: version,
      createdAt: now,
      updatedAt: now,
    }),
    'utf8',
  );
  await writeFile(
    path.join(bootstrapDir, `config.candidate-${generation}.env`),
    'DATABASE_URL="postgresql://u:p@h:5432/db"\n',
    'utf8',
  );
  // Existing installer-written config that must survive promotion.
  const envFile = path.join(stateDir, 'stackpanel.env');
  await writeFile(
    envFile,
    'STACKPANEL_DATA_DIR="/var/lib/stackpanel/data"\nJWT_SECRET="keep-me"\nSTACKPANEL_SETUP_TOKEN="tok"\n',
    'utf8',
  );

  return { root, stateDir, layout, envFile, migrateDir, version, generation };
}

function options(f: Awaited<ReturnType<typeof fixture>>, runner: FakeRunner, extra = {}) {
  return {
    layout: f.layout,
    runner,
    probe: async () => true,
    now: () => new Date(),
    log: () => {},
    ...extra,
  };
}

describe('runBootstrap', () => {
  it('migrates, promotes the candidate, rebuilds PM2 and reaches needs_admin', async () => {
    const f = await fixture();
    const runner = new FakeRunner();

    const result = await runBootstrap(options(f, runner));

    expect(result).toEqual({ ok: true, phase: 'needs_admin' });

    // Migration ran with the candidate DSN, not the installer's env.
    const migrate = runner.migrationCall();
    expect(migrate?.env?.['DATABASE_URL']).toBe('postgresql://u:p@h:5432/db');

    // The promoted file keeps installer keys and adds the candidate keys.
    const promoted = await readFile(f.envFile, 'utf8');
    expect(promoted).toContain('JWT_SECRET="keep-me"');
    expect(promoted).toContain('STACKPANEL_SETUP_TOKEN="tok"');
    expect(promoted).toContain('STACKPANEL_DATA_DIR="/var/lib/stackpanel/data"');
    expect(promoted).toContain('DATABASE_URL="postgresql://u:p@h:5432/db"');

    const state = await readBootstrapState(f.layout);
    expect(state).toMatchObject({
      phase: 'needs_admin',
      migrationSucceeded: true,
      runtimeReady: true,
      adminClaimed: false,
    });
    // The terminal phase and admin claim are independent.
    expect(state?.adminClaimed).toBe(false);
  });

  it('starts the worker only after migration (delete + start + save)', async () => {
    const f = await fixture();
    const runner = new FakeRunner();

    await runBootstrap(options(f, runner));

    const calls = runner.calls.map((call) => `${call.file} ${call.args.join(' ')}`);
    expect(calls.some((line) => line.startsWith('pm2 delete'))).toBe(true);
    expect(calls.some((line) => line.includes('ecosystem.config.cjs'))).toBe(true);
    expect(calls.some((line) => line === 'pm2 save')).toBe(true);
  });

  it('enters migration_failed and does not promote config when migration fails', async () => {
    const f = await fixture();
    const runner = new FakeRunner({
      failMigrate: "Can't reach database server at 127.0.0.1:1",
    });

    const result = await runBootstrap(options(f, runner));

    expect(result).toMatchObject({ ok: false, phase: 'migration_failed' });

    const state = await readBootstrapState(f.layout);
    expect(state).toMatchObject({
      phase: 'migration_failed',
      migrationSucceeded: false,
      failure: 'migration_connect_failed',
    });
    // The installer-written config is untouched: the broken DSN never lands.
    const env = await readFile(f.envFile, 'utf8');
    expect(env).not.toContain('postgresql://u:p@h:5432/db');
    // No PM2 rebuild happened.
    expect(runner.pm2Calls()).toEqual([]);
  });

  it('does not reopen the config surface after a migration succeeded but startup failed', async () => {
    const f = await fixture();
    const runner = new FakeRunner();

    const result = await runBootstrap(
      options(f, runner, {
        probe: async () => false,
        startupTimeoutMs: 1_500,
      }),
    );

    expect(result).toMatchObject({ ok: false, phase: 'runtime_failed' });
    const state = await readBootstrapState(f.layout);
    expect(state).toMatchObject({
      phase: 'runtime_failed',
      migrationSucceeded: true,
      runtimeReady: false,
    });
    // Crucially: phase is NOT needs_infra, so `/setup` cannot rewrite the DSN.
    expect(state?.phase).not.toBe('needs_infra');
  });

  it('is idempotent when the phase is no longer queued', async () => {
    const f = await fixture({ phase: 'needs_admin' });
    const runner = new FakeRunner();

    const result = await runBootstrap(options(f, runner));

    expect(result).toEqual({ ok: true, phase: 'needs_admin' });
    // Nothing destructive ran.
    expect(runner.calls).toEqual([]);
  });

  it('refuses to execute a task whose generation does not match the disk state', async () => {
    const f = await fixture();
    const runner = new FakeRunner();

    await expect(
      runBootstrap(options(f, runner, { expectedGeneration: 99 })),
    ).rejects.toThrow(/代次/);
    expect(runner.migrationCall()).toBeUndefined();
  });

  it('refuses an incomplete migrate bundle before running anything', async () => {
    const f = await fixture({ missingFile: 'prisma.config.mjs' });
    const runner = new FakeRunner();

    await expect(runBootstrap(options(f, runner))).rejects.toThrow(/prisma.config.mjs/);
    expect(runner.migrationCall()).toBeUndefined();
  });

  it('refuses a migrate bundle whose version does not match the kernel', async () => {
    const f = await fixture({ migrateVersion: '9.9.9' });
    const runner = new FakeRunner();

    await expect(runBootstrap(options(f, runner))).rejects.toThrow(/版本/);
    expect(runner.migrationCall()).toBeUndefined();
  });

  it('refuses a bundle built for another Node major', async () => {
    const f = await fixture({ nodeMajor: 999 });
    const runner = new FakeRunner();

    await expect(runBootstrap(options(f, runner))).rejects.toThrow(/Node/);
    expect(runner.migrationCall()).toBeUndefined();
  });

  it('reports runtime_failed when the worker never comes online', async () => {
    const f = await fixture();
    const runner = new FakeRunner({ workerOnline: false });

    const result = await runBootstrap(
      options(f, runner, {
        probe: async () => true,
        // Shorten the worker poll so the test does not take minutes.
        startupTimeoutMs: 1_500,
      }),
    );

    expect(result).toMatchObject({ ok: false, phase: 'runtime_failed' });
    const state = await readBootstrapState(f.layout);
    expect(state).toMatchObject({ phase: 'runtime_failed', migrationSucceeded: true });
  }, 30_000);
});

describe('assertMigrateBundleComplete', () => {
  it('lists every missing file instead of failing on the first', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-migrate-incomplete-'));
    await expect(assertMigrateBundleComplete(dir)).rejects.toThrow(
      /migrate.mjs.*prisma.config.mjs/s,
    );
  });
});

describe('assertBundleMatchesKernel', () => {
  it('rejects a kernel release that is not role=kernel', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sp-bundle-mismatch-'));
    const migrate = path.join(root, 'migrate');
    const kernel = path.join(root, 'kernel');
    await mkdir(migrate, { recursive: true });
    await mkdir(kernel, { recursive: true });
    await writeFile(
      path.join(migrate, 'RELEASE.json'),
      JSON.stringify({ version: '1.0.0', role: 'migrate', nodeMajor: 22 }),
      'utf8',
    );
    await writeFile(
      path.join(kernel, 'RELEASE.json'),
      JSON.stringify({ version: '1.0.0', role: 'migrate', nodeMajor: 22 }),
      'utf8',
    );
    await expect(
      assertBundleMatchesKernel({
        migrateDir: migrate,
        currentReleaseDir: kernel,
        expectedVersion: '1.0.0',
      }),
    ).rejects.toThrow(/role/);
  });
});

describe('classifyMigrationError', () => {
  it('separates retryable connection errors from manual-intervention cases', () => {
    expect(classifyMigrationError(new Error("Can't reach database server"))).toBe(
      'migration_connect_failed',
    );
    expect(classifyMigrationError(new Error('password authentication failed'))).toBe(
      'migration_permission_denied',
    );
    expect(classifyMigrationError(new Error('P3009 found failed migrations'))).toBe(
      'migration_failed_record',
    );
    expect(classifyMigrationError(new Error('P3005 schema is not empty'))).toBe(
      'migration_schema_incompatible',
    );
    expect(classifyMigrationError(new Error('something else'))).toBe('migration_unknown');
  });
});

describe('runBootstrap — crash recovery (BOOTSTRAP-R3)', () => {
  it('refuses to resume without the explicit resume flag', async () => {
    // `migrating` is not writable, not queued: the path unit waking up again
    // must not silently re-run a migration.
    for (const phase of ['migrating', 'starting'] as const) {
      const f = await fixture({ phase });
      const runner = new FakeRunner();
      const result = await runBootstrap(options(f, runner));
      expect(result).toEqual({ ok: true, phase });
      expect(runner.migrationCall()).toBeUndefined();
      expect(runner.pm2Calls()).toEqual([]);
    }
  });

  it('resumes an interrupted migration from `migrating`, then proceeds normally', async () => {
    const f = await fixture({ phase: 'migrating' });
    const runner = new FakeRunner();

    const result = await runBootstrap(options(f, runner, { resume: true }));

    expect(result).toEqual({ ok: true, phase: 'needs_admin' });
    // Safe to repeat: `prisma migrate deploy` is idempotent, and the state was
    // left mid-operation so nothing else could have completed it.
    expect(runner.migrationCall()).toBeDefined();
    expect((await readBootstrapState(f.layout))?.phase).toBe('needs_admin');
  });

  it('resumes from `starting` without re-running the migration', async () => {
    const f = await fixture({ phase: 'starting' });
    const runner = new FakeRunner();

    const result = await runBootstrap(options(f, runner, { resume: true }));

    expect(result).toEqual({ ok: true, phase: 'needs_admin' });
    // The config was already promoted and the migration committed. Re-running
    // it would risk reporting a false `migration_failed` on a working install.
    expect(runner.migrationCall()).toBeUndefined();
    // It still has to rebuild processes and probe them.
    expect(runner.pm2Calls().length).toBeGreaterThan(0);
  });

  it('does not resume a terminal or failed phase even when asked', async () => {
    for (const phase of ['complete', 'needs_admin', 'runtime_failed', 'migration_failed'] as const) {
      const f = await fixture({ phase });
      const runner = new FakeRunner();
      const result = await runBootstrap(options(f, runner, { resume: true }));
      expect(result).toEqual({ ok: true, phase });
      expect(runner.migrationCall()).toBeUndefined();
    }
  });

  it('keeps runtime_failed when the resumed start fails again', async () => {
    const f = await fixture({ phase: 'starting' });
    const runner = new FakeRunner();
    const result = await runBootstrap(
      options(f, runner, { resume: true, probe: async () => false, startupTimeoutMs: 50 }),
    );
    if (result.ok) throw new Error('expected failure');
    expect(result.phase).toBe('runtime_failed');
    expect((await readBootstrapState(f.layout))?.phase).toBe('runtime_failed');
    // Crucially, it must not fall back to the writable phase.
    expect((await readBootstrapState(f.layout))?.migrationSucceeded).toBe(true);
  });
});
