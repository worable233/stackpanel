import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateTask } from '@stackpanel/spec';
import type { CommandRequest, CommandResult, CommandRunner } from '../src/command.ts';
import {
  ComposeDeploymentAdapter,
  ComposeSelfUpdateAdapter,
  DeploymentAdapterError,
  parseDfFreeBytes,
} from '../src/compose-adapter.ts';
import { validateComposeConfig, type ComposeProjectConfig } from '../src/compose-config.ts';
import { FileDeploymentPointer } from '../src/deployment-pointer.ts';
import { FileSnapshotStore } from '../src/snapshot-store.ts';

/** Recording fake runner: matches requests by predicate, returns scripted results. */
function fakeRunner(handler: (req: CommandRequest) => CommandResult | undefined = () => undefined) {
  const calls: CommandRequest[] = [];
  const runner: CommandRunner = {
    async run(req) {
      calls.push(req);
      const scripted = handler(req);
      if (scripted) return scripted;
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { runner, calls };
}

const DIGEST = 'sha256:' + 'a'.repeat(64);

function config(overrides: Partial<ComposeProjectConfig> = {}): ComposeProjectConfig {
  return {
    projectName: 'sp',
    projectDir: '/srv/stackpanel',
    composeFiles: ['docker-compose.yml'],
    services: { api: 'api', worker: 'worker', web: 'web' },
    imageEnv: 'STACKPANEL_IMAGE',
    imageRepository: 'ghcr.io/acme/stackpanel',
    allowedServices: ['api', 'worker', 'web'],
    database: { service: 'postgres', user: 'stackpanel', name: 'stackpanel' },
    probes: { readinessUrl: 'http://api:3001/health' },
    ...overrides,
  };
}

function task(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    protocolVersion: 1,
    instanceId: 'sp',
    baselineGeneration: 0,
    targetDigest: DIGEST,
    planDigest: 'plan',
    idempotencyKey: 'k1',
    policyVersion: 1,
    plan: {
      kernel: { version: '0.3.0', digest: DIGEST, migration: 'm1' },
      packages: [],
      planDigestInput: { kernelVersion: '0.3.0', packages: [], frontendAbi: '1', schemaRange: '*' },
    },
    createdAt: '2026-10-17T00:00:00Z',
    ...overrides,
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-adapter-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('compose-config', () => {
  it('rejects incomplete bindings', () => {
    expect(() => validateComposeConfig(config({ imageRepository: '' }))).toThrow(/imageRepository/);
    expect(() => validateComposeConfig(config({ allowedServices: ['api'] }))).toThrow(/受管服务/);
  });

  it('accepts a complete binding', () => {
    expect(validateComposeConfig(config())).toBeDefined();
  });
});

describe('FileDeploymentPointer', () => {
  it('advances generation and remembers the previous digest', async () => {
    const pointer = FileDeploymentPointer.resolve(root);
    expect(await pointer.read()).toBeNull();
    const first = await pointer.advance({
      digest: 'sha256:1',
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(first.generation).toBe(1);
    expect(first.previousDigest).toBeNull();
    const second = await pointer.advance({
      digest: 'sha256:2',
      now: new Date('2026-01-02T00:00:00Z'),
    });
    expect(second.generation).toBe(2);
    expect(second.previousDigest).toBe('sha256:1');
  });
});

describe('parseDfFreeBytes', () => {
  it('parses the available column in KB', () => {
    const out = `Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/sda 100 5 95 5% /`;
    expect(parseDfFreeBytes(out)).toBe(95 * 1024);
  });
});

describe('ComposeDeploymentAdapter', () => {
  function adapterFor(
    handler?: (req: CommandRequest) => CommandResult | undefined,
    overrides: Partial<ComposeProjectConfig> = {},
  ) {
    const { runner, calls } = fakeRunner(handler);
    const probes: string[] = [];
    const adapter = new ComposeDeploymentAdapter({
      config: config(overrides),
      runner,
      stateDir: root,
      probe: async (url) => {
        probes.push(url);
        return true;
      },
      now: () => new Date('2026-10-17T00:00:00Z'),
    });
    return { adapter, calls, probes };
  }

  it('downloads the pinned digest image and verifies the local RepoDigest', async () => {
    const { adapter, calls } = adapterFor((req) => {
      if (req.args.includes('image') && req.args.includes('inspect')) {
        return { code: 0, stdout: `ghcr.io/acme/stackpanel@${DIGEST}\n`, stderr: '' };
      }
      return undefined;
    });
    const result = await adapter.download({
      task: task(),
      targetDigest: DIGEST,
      planDigest: 'p',
      workDir: root,
    });
    expect(result.credential).toContain(DIGEST);
    expect(calls.some((c) => c.args[0] === 'pull')).toBe(true);
  });

  it('fails download when the pulled digest does not match', async () => {
    const { adapter } = adapterFor((req) => {
      if (req.args.includes('inspect'))
        return { code: 0, stdout: 'ghcr.io/acme/stackpanel@sha256:' + 'b'.repeat(64), stderr: '' };
      return undefined;
    });
    await expect(
      adapter.download({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root }),
    ).rejects.toBeInstanceOf(DeploymentAdapterError);
  });

  it('rejects a stale plan when the generation moved', async () => {
    const pointer = FileDeploymentPointer.resolve(root);
    await pointer.write({
      generation: 5,
      digest: DIGEST,
      previousDigest: null,
      previousGeneration: null,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { adapter } = adapterFor();
    await expect(
      adapter.preflight({
        task: task({ baselineGeneration: 4 }),
        targetDigest: DIGEST,
        planDigest: 'p',
        workDir: root,
      }),
    ).rejects.toThrow(/基线代次/);
  });

  it('fails preflight when free disk is below the floor', async () => {
    const { adapter } = adapterFor(
      (req) =>
        req.file === 'df' ? { code: 0, stdout: 'x 1024 5 9 5% /\n', stderr: '' } : undefined,
      { minFreeBytes: 1024 * 1024 },
    );
    await expect(
      adapter.preflight({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root }),
    ).rejects.toThrow(/磁盘不足/);
  });

  it('quiesces worker and web before snapshot', async () => {
    const { adapter, calls } = adapterFor();
    await adapter.quiesce({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root });
    const stop = calls.find((c) => c.args.includes('stop'));
    expect(stop?.args).toEqual(expect.arrayContaining(['stop', 'worker', 'web']));
  });

  it('snapshots the database to a binary dump and records the ref', async () => {
    const { adapter, calls } = adapterFor();
    const result = await adapter.snapshot({
      task: task(),
      targetDigest: DIGEST,
      planDigest: 'p',
      workDir: root,
    });
    const dump = calls.find((c) => c.args.includes('pg_dump'));
    expect(dump?.stdoutFile).toBeDefined();
    const stored = await FileSnapshotStore.resolve(root).read();
    expect(stored?.ref).toBe(result.backupRef);
  });

  it('switches all managed services to the same target release set', async () => {
    const { adapter, calls } = adapterFor();
    await adapter.switchTo({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root });
    const up = calls.find((c) => c.args.includes('up'));
    expect(up?.env?.['STACKPANEL_IMAGE']).toBe(`ghcr.io/acme/stackpanel@${DIGEST}`);
    expect(up?.args).toEqual(expect.arrayContaining(['api', 'worker', 'web']));
  });

  it('runs migration as a one-shot task on the target image', async () => {
    const { adapter, calls } = adapterFor();
    await adapter.migrate({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root });
    const run = calls.find((c) => c.args.includes('run'));
    expect(run?.args).toEqual(expect.arrayContaining(['run', '--rm', '--no-deps']));
    expect(run?.env?.['STACKPANEL_IMAGE']).toBe(`ghcr.io/acme/stackpanel@${DIGEST}`);
  });

  it('fails verify when the readiness probe fails', async () => {
    const { runner } = fakeRunner();
    const adapter = new ComposeDeploymentAdapter({
      config: config(),
      runner,
      stateDir: root,
      probe: async () => false,
    });
    await expect(
      adapter.verify({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root }),
    ).rejects.toThrow(/readiness/);
  });

  it('commits by advancing the pointer only after probes pass', async () => {
    const { adapter } = adapterFor();
    const result = await adapter.commit({
      task: task(),
      targetDigest: DIGEST,
      planDigest: 'p',
      workDir: root,
    });
    expect(result.credential).toContain('gen=1');
    expect((await FileDeploymentPointer.resolve(root).read())?.digest).toBe(DIGEST);
  });

  it('never restores an old snapshot after writes opened (postWrite)', async () => {
    const { adapter, calls } = adapterFor();
    const result = await adapter.recover(
      { task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root },
      { stage: 'switchTo', detail: 'boom', migrated: true, postWrite: true },
    );
    expect(result.recovered).toBe(false);
    expect(calls.some((c) => c.args.includes('pg_restore'))).toBe(false);
  });

  it('restores the snapshot when a post-migration (pre-write) failure occurs', async () => {
    const { adapter, calls } = adapterFor();
    await adapter.snapshot({ task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root });
    const result = await adapter.recover(
      { task: task(), targetDigest: DIGEST, planDigest: 'p', workDir: root },
      { stage: 'migrating', detail: 'boom', migrated: true, postWrite: false },
    );
    expect(calls.some((c) => c.args.includes('pg_restore'))).toBe(true);
    expect(result.recovered).toBe(true);
  });

  it('rolls back to the previous digest and advances the pointer generation', async () => {
    const pointer = FileDeploymentPointer.resolve(root);
    await pointer.write({
      generation: 4,
      digest: 'sha256:' + 'b'.repeat(64),
      previousDigest: 'sha256:' + 'c'.repeat(64),
      previousGeneration: 3,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { adapter, calls } = adapterFor((req) =>
      req.args.includes('up') ? { code: 0, stdout: '', stderr: '' } : undefined,
    );
    const result = await adapter.rollbackToPrevious();
    expect(result.ok).toBe(true);
    const up = calls.find((c) => c.args.includes('up'));
    expect(up?.env?.['STACKPANEL_IMAGE']).toBe('sha256:' + 'c'.repeat(64));
    const after = await FileDeploymentPointer.resolve(root).read();
    expect(after?.digest).toBe('sha256:' + 'c'.repeat(64));
    expect(after?.generation).toBe(5);
    // The rolled-back-from generation is preserved for a forward re-roll.
    expect(after?.previousDigest).toBe('sha256:' + 'b'.repeat(64));
  });

  it('refuses to roll back when there is no previous generation', async () => {
    const { adapter, calls } = adapterFor();
    const result = await adapter.rollbackToPrevious();
    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.args.includes('up'))).toBe(false);
  });

  it('reconciles by reading the pointer and probing readiness', async () => {
    const pointer = FileDeploymentPointer.resolve(root);
    await pointer.write({
      generation: 6,
      digest: DIGEST,
      previousDigest: null,
      previousGeneration: null,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const { adapter, probes } = adapterFor();
    const result = await adapter.reconcile();
    expect(result.ok).toBe(true);
    expect(result.generation).toBe(6);
    expect(result.digest).toBe(DIGEST);
    expect(probes).toContain('http://api:3001/health');
  });

  it('self-updates the updater service by switching its image env', async () => {
    const { runner, calls } = fakeRunner((req) => {
      if (req.args.includes('images')) {
        return {
          code: 0,
          stdout: JSON.stringify({ Repository: 'ghcr.io/acme/updater', Tag: '1.0.0' }),
          stderr: '',
        };
      }
      if (req.args.includes('image') && req.args.includes('inspect')) {
        return { code: 0, stdout: `ghcr.io/acme/stackpanel@${DIGEST}\n`, stderr: '' };
      }
      return undefined;
    });
    const self = new ComposeSelfUpdateAdapter(config(), runner);
    expect(await self.currentUpdaterImage()).toBe('ghcr.io/acme/updater:1.0.0');
    await self.pullAndVerifyUpdater(DIGEST);
    await self.switchUpdaterTo(DIGEST);
    const up = calls.find((c) => c.args.includes('up'));
    expect(up?.env?.['STACKPANEL_UPDATER_IMAGE']).toBe(`ghcr.io/acme/stackpanel@${DIGEST}`);
    expect(up?.args).toEqual(expect.arrayContaining(['up', '-d', 'updater']));
  });
});
