import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateTask } from '@stackpanel/spec';
import type { DeploymentAdapter, StepContext } from '../src/deployment-adapter.ts';
import { RecoveryCoordinator, MAX_AUTO_RETRIES } from '../src/recovery-actions.ts';
import { FileUpdateJournal } from '../src/journal.ts';
import { FileDeploymentPointer } from '../src/deployment-pointer.ts';
import { FileUpdaterStatus } from '../src/status.ts';
import { FileUpdateTaskChannel } from '../src/task-channel.ts';

const INSTANCE = 'inst1';

function task(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    protocolVersion: 1,
    instanceId: INSTANCE,
    baselineGeneration: 3,
    targetDigest: 'sha256:' + 'a'.repeat(64),
    planDigest: 'plan-digest',
    idempotencyKey: 'k1',
    policyVersion: 1,
    plan: {
      kernel: { version: '0.3.0', digest: 'sha256:' + 'a'.repeat(64), migration: 'm1' },
      packages: [],
      planDigestInput: { kernelVersion: '0.3.0', packages: [], frontendAbi: '1', schemaRange: '*' },
    },
    createdAt: '2026-10-17T00:00:00Z',
    ...overrides,
  };
}

/** Adapter that only records which limited recovery methods were invoked. */
function adapter(overrides: Partial<DeploymentAdapter> = {}): DeploymentAdapter {
  return {
    download: async () => ({ credential: 'c' }),
    preflight: async () => ({ credential: 'c' }),
    quiesce: async () => ({ credential: 'c' }),
    snapshot: async () => ({ credential: 'c', backupRef: 'b' }),
    migrate: async () => ({ credential: 'c' }),
    switchTo: async () => ({ credential: 'c' }),
    verify: async () => ({ credential: 'c' }),
    commit: async () => ({ credential: 'c' }),
    cleanup: async () => ({ credential: 'c' }),
    recover: async (_ctx: StepContext) => ({ recovered: true, credential: 'c' }),
    ...overrides,
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-recovery-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function make(overrides: { adapter?: DeploymentAdapter } = {}) {
  const channel = new FileUpdateTaskChannel(path.join(root, 'channel'));
  const journal = new FileUpdateJournal(path.join(root, 'journal.jsonl'));
  const status = FileUpdaterStatus.resolve(root);
  const pointer = FileDeploymentPointer.resolve(root);
  const coord = new RecoveryCoordinator({
    instanceId: INSTANCE,
    channel,
    journal,
    status,
    pointer,
    adapter: overrides.adapter ?? adapter(),
    now: () => new Date('2026-10-17T12:00:00Z'),
  });
  return { coord, channel, journal, status, pointer };
}

describe('RecoveryCoordinator', () => {
  it('retries by re-submitting the archived task under a fresh idempotency key', async () => {
    const now = new Date('2026-10-17T12:00:00Z');
    const { coord, channel, pointer } = make();
    await pointer.write({
      generation: 7,
      digest: 'sha256:' + 'b'.repeat(64),
      previousDigest: null,
      previousGeneration: null,
      updatedAt: '2026-10-17T00:00:00Z',
    });
    await channel.archiveTask(task());

    const result = await coord.retry('k1');
    expect(result.ok).toBe(true);

    const claimed = await channel.claim(INSTANCE);
    expect(claimed).not.toBeNull();
    expect(claimed?.idempotencyKey).toBe(`k1-retry-${now.getTime()}`);
    // Baseline is refreshed to the current pointer generation, not the stale plan value.
    expect(claimed?.baselineGeneration).toBe(7);
  });

  it('picks the latest retryable result when no key is given', async () => {
    const { coord, channel, status } = make();
    await channel.archiveTask(task({ idempotencyKey: 'old' }));
    await status.write({
      generation: 3,
      digest: 'sha256:abc',
      activeTask: null,
      recent: [
        { idempotencyKey: 'fallback-key', result: { phase: 'recovery_failed', checkpoints: [] } },
      ],
      updatedAt: '2026-10-17T00:00:00Z',
    });
    // Archive the fallback task so retry can find it.
    await channel.archiveTask(task({ idempotencyKey: 'fallback-key' }));

    const result = await coord.retry();
    expect(result.ok).toBe(true);
    const claimed = await channel.claim(INSTANCE);
    expect(claimed?.idempotencyKey.startsWith('fallback-key-retry-')).toBe(true);
    // The earlier archived task must not be picked.
    const second = await channel.claim(INSTANCE);
    expect(second).toBeNull();
  });

  it('refuses to retry a task with no archived declaration', async () => {
    const { coord } = make();
    const result = await coord.retry('missing');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/归档/);
  });

  it('stops auto-retrying after the cap', async () => {
    const { coord, channel, journal } = make();
    await channel.archiveTask(task());
    // Record MAX_AUTO_RETRIES prior retries in the journal.
    for (let i = 0; i < MAX_AUTO_RETRIES; i += 1) {
      await journal.append({
        at: '2026-10-17T00:00:00Z',
        instanceId: INSTANCE,
        taskKey: `${INSTANCE}:k1-retry-${i}`,
        phase: 'queued',
        inputDigest: 'd',
      });
    }
    const result = await coord.retry('k1');
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/上限/);
  });

  it('rolls back via the adapter when the capability exists', async () => {
    let called = 0;
    const { coord } = make({
      adapter: adapter({
        rollbackToPrevious: async () => {
          called += 1;
          return { ok: true, detail: 'rolled back' };
        },
      }),
    });
    const result = await coord.rollback();
    expect(called).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe('rolled back');
  });

  it('reports rollback as unsupported (never fake success) when the adapter lacks it', async () => {
    const { coord } = make();
    const result = await coord.rollback();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/不支持/);
  });

  it('reconciles against the adapter and reports the live generation/digest', async () => {
    const { coord, pointer } = make({
      adapter: adapter({
        reconcile: async () => ({
          ok: true,
          generation: 5,
          digest: 'sha256:' + 'c'.repeat(64),
          detail: 'readiness 探针通过',
        }),
      }),
    });
    await pointer.write({
      generation: 5,
      digest: 'sha256:' + 'c'.repeat(64),
      previousDigest: null,
      previousGeneration: null,
      updatedAt: '2026-10-17T00:00:00Z',
    });
    const result = await coord.reconcile();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('代次 5');
    expect(result.detail).toContain('readiness 探针通过');
  });

  it('reconcile still reports the local pointer when the adapter has no capability', async () => {
    const { coord, pointer } = make();
    await pointer.write({
      generation: 2,
      digest: 'sha256:' + 'd'.repeat(64),
      previousDigest: null,
      previousGeneration: null,
      updatedAt: '2026-10-17T00:00:00Z',
    });
    const result = await coord.reconcile();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('代次 2');
  });
});
