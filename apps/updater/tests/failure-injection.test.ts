import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FAILURE_FALLBACKS, type UpdateTask } from '@stackpanel/spec';
import type { DeploymentAdapter, StepContext } from '../src/deployment-adapter.ts';
import { UpdateEngine } from '../src/engine.ts';
import { ExecutorLock } from '../src/executor-lock.ts';
import { FileUpdateJournal } from '../src/journal.ts';

/**
 * §13-7 失败注入矩阵：把 §6 兜底表的每个阶段映射到执行引擎的失败点，断言引擎把正确的
 * 「是否已迁移 / 是否已放行写入」信号交给适配器恢复，并且**迁移后 / 放行写入后绝不自动
 * 恢复旧快照**。整条路径用假适配器驱动，不碰真实 Docker。
 */

/** 引擎失败点 → §6 失败阶段 + 期望的恢复信号。 */
const MATRIX: Array<{
  phase: string;
  stage: string;
  /** 该阶段失败时是否已迁移。 */
  migrated: boolean;
  /** 该阶段失败时是否已提交并放行写入。 */
  postWrite: boolean;
}> = [
  { phase: 'downloading', stage: 'download', migrated: false, postWrite: false },
  { phase: 'preflight', stage: 'preflight', migrated: false, postWrite: false },
  { phase: 'quiescing', stage: 'quiesce', migrated: false, postWrite: false },
  { phase: 'snapshotting', stage: 'snapshot', migrated: false, postWrite: false },
  { phase: 'migrating', stage: 'migration', migrated: false, postWrite: false },
  { phase: 'switching', stage: 'new_version_start', migrated: true, postWrite: false },
  { phase: 'verifying', stage: 'probe', migrated: true, postWrite: false },
  { phase: 'cleanup', stage: 'post_write', migrated: true, postWrite: true },
];

function task(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    protocolVersion: 1,
    instanceId: 'i1',
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

interface RecoverCall {
  stage: string;
  migrated: boolean;
  postWrite: boolean;
}

/** Adapter that fails at a given engine phase and records the recovery signal. */
function failingAdapter(failAt: string) {
  const recoverCalls: RecoverCall[] = [];
  const make = (name: string) => async (): Promise<{ credential: string; backupRef: string }> => {
    if (name === failAt) throw new Error(`boom at ${name}`);
    return { credential: `${name}-cred`, backupRef: `${name}-backup` };
  };
  const adapter: DeploymentAdapter = {
    download: make('downloading'),
    preflight: make('preflight'),
    quiesce: make('quiescing'),
    snapshot: make('snapshotting'),
    migrate: make('migrating'),
    switchTo: make('switching'),
    verify: make('verifying'),
    commit: make('committed'),
    cleanup: make('cleanup'),
    async recover(
      _ctx: StepContext,
      failure: { stage: string; migrated: boolean; postWrite: boolean },
    ) {
      recoverCalls.push({
        stage: failure.stage,
        migrated: failure.migrated,
        postWrite: failure.postWrite,
      });
      return { recovered: true, credential: 'recovered' };
    },
  };
  return { adapter, recoverCalls };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-fi-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function engineFor(adapter: DeploymentAdapter, id = 'k1') {
  const journal = new FileUpdateJournal(path.join(root, `journal-${id}.jsonl`));
  const lock = new ExecutorLock({ filePath: path.join(root, 'lock'), owner: 'test:1' });
  return new UpdateEngine({ adapter, journal, lock, workDir: path.join(root, 'work') });
}

describe('§6 failure-injection matrix', () => {
  it('covers every documented fallback stage', () => {
    const documented = new Set(FAILURE_FALLBACKS.map((f) => f.stage));
    for (const row of MATRIX) {
      expect(documented.has(row.stage as (typeof FAILURE_FALLBACKS)[number]['stage'])).toBe(true);
    }
  });

  for (const row of MATRIX) {
    it(`fails at ${row.phase} → recovering with migrated=${row.migrated}, postWrite=${row.postWrite}`, async () => {
      const { adapter, recoverCalls } = failingAdapter(row.phase);
      const engine = engineFor(adapter, row.phase);
      const result = await engine.run(task());
      expect(result.phase).toBe('recovered');
      expect(recoverCalls).toHaveLength(1);
      expect(recoverCalls[0]?.migrated).toBe(row.migrated);
      expect(recoverCalls[0]?.postWrite).toBe(row.postWrite);
    });
  }

  it('never reports recovery for a post-write failure as snapshot-restorable', async () => {
    const { adapter, recoverCalls } = failingAdapter('cleanup');
    const engine = engineFor(adapter, 'postwrite');
    await engine.run(task({ idempotencyKey: 'k-postwrite' }));
    expect(recoverCalls[0]?.postWrite).toBe(true);
  });

  it('treats a task that already ended in recovery as terminal (no re-execution)', async () => {
    // First run fails at migrate (pre-migration) and recovers → terminal.
    const first = failingAdapter('migrating');
    await engineFor(first.adapter, 'rerun').run(task({ idempotencyKey: 'k-rerun' }));
    // A second run over the same journal must not re-run any adapter action.
    const calls: string[] = [];
    const healthy: DeploymentAdapter = {
      download: async () => {
        calls.push('download');
        return { credential: 'c' };
      },
      preflight: async () => {
        calls.push('preflight');
        return { credential: 'c' };
      },
      quiesce: async () => ({ credential: 'c' }),
      snapshot: async () => ({ credential: 'c', backupRef: 'b' }),
      migrate: async () => {
        calls.push('migrate');
        return { credential: 'c' };
      },
      switchTo: async () => ({ credential: 'c' }),
      verify: async () => ({ credential: 'c' }),
      commit: async () => ({ credential: 'c' }),
      cleanup: async () => ({ credential: 'c' }),
      recover: async () => ({ recovered: true, credential: 'c' }),
    };
    const journal = new FileUpdateJournal(path.join(root, 'journal-rerun.jsonl'));
    const lock = new ExecutorLock({ filePath: path.join(root, 'lock'), owner: 'test:1' });
    const engine = new UpdateEngine({
      adapter: healthy,
      journal,
      lock,
      workDir: path.join(root, 'work'),
    });
    const result = await engine.run(task({ idempotencyKey: 'k-rerun' }));
    // The task ended in a terminal phase (recovered), so it is not re-driven.
    expect(result.phase).toBe('recovered');
    expect(calls).toHaveLength(0);
  });
});
