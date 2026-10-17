import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateTask } from '@stackpanel/spec';
import type { DeploymentAdapter, StepContext } from '../src/deployment-adapter.ts';
import { UpdateEngine } from '../src/engine.ts';
import { ExecutorLock } from '../src/executor-lock.ts';
import { FileUpdateJournal } from '../src/journal.ts';

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

/** Fake adapter recording every call; can be told to fail at a phase. */
function fakeAdapter(options: { failAt?: string; recoverable?: boolean } = {}) {
  const calls: string[] = [];
  const make =
    (name: string, extra?: () => Record<string, unknown>) =>
    async (_ctx: StepContext): Promise<{ credential: string; backupRef: string }> => {
      calls.push(name);
      if (options.failAt === name) throw new Error(`boom at ${name}`);
      return {
        credential: `${name}-cred`,
        backupRef: `${name}-backup`,
        ...(extra ? extra() : {}),
      };
    };
  const adapter: DeploymentAdapter = {
    download: make('download'),
    preflight: make('preflight'),
    quiesce: make('quiesce'),
    snapshot: make('snapshot', () => ({ backupRef: 'backup-1' })),
    migrate: make('migrate'),
    switchTo: make('switchTo'),
    verify: make('verify'),
    commit: make('commit'),
    cleanup: make('cleanup'),
    async recover() {
      calls.push('recover');
      return { recovered: options.recoverable !== false, credential: 'recover-cred' };
    },
  };
  return { adapter, calls };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-engine-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function engineFor(adapter: DeploymentAdapter) {
  const journal = new FileUpdateJournal(path.join(root, 'journal.jsonl'));
  const lock = new ExecutorLock({ filePath: path.join(root, 'executor.lock'), owner: 'test:1' });
  const engine = new UpdateEngine({ adapter, journal, lock, workDir: path.join(root, 'work') });
  return { engine, journal, lock };
}

describe('UpdateEngine', () => {
  it('drives the full success path and records ordered checkpoints', async () => {
    const { adapter, calls } = fakeAdapter();
    const { engine, journal } = engineFor(adapter);
    const result = await engine.run(task());
    expect(result.phase).toBe('committed');
    expect(calls).toEqual([
      'download',
      'preflight',
      'quiesce',
      'snapshot',
      'migrate',
      'switchTo',
      'verify',
      'commit',
      'cleanup',
    ]);
    const phases = (await journal.forTask('i1:k1')).map((e) => e.phase);
    expect(phases).toEqual([
      'queued',
      'resolving',
      'downloading',
      'verified',
      'preflight',
      'quiescing',
      'snapshotting',
      'migrating',
      'switching',
      'verifying',
      'committed',
      'cleanup',
    ]);
  });

  it('blocks without executing when not approved', async () => {
    const { adapter, calls } = fakeAdapter();
    const { engine, journal } = engineFor(adapter);
    const result = await engine.run(task(), false);
    expect(result.phase).toBe('blocked');
    expect(calls).toEqual([]);
    expect(await journal.latestPhase('i1:k1')).toBe('blocked');
  });

  it('recovers when a pre-migration step fails', async () => {
    const { adapter, calls } = fakeAdapter({ failAt: 'download' });
    const { engine, journal } = engineFor(adapter);
    const result = await engine.run(task());
    expect(result.phase).toBe('recovered');
    expect(calls).toContain('recover');
    const entries = await journal.forTask('i1:k1');
    expect(entries.some((e) => e.phase === 'recovering')).toBe(true);
    expect(entries.some((e) => e.phase === 'recovered')).toBe(true);
    // 迁移未开始，不应有 migrate 之后的阶段。
    expect(entries.some((e) => e.phase === 'migrating')).toBe(false);
  });

  it('reports recovery_failed when the adapter cannot recover', async () => {
    const { adapter } = fakeAdapter({ failAt: 'verify', recoverable: false });
    const { engine, journal } = engineFor(adapter);
    const result = await engine.run(task());
    expect(result.phase).toBe('recovery_failed');
    expect(await journal.latestPhase('i1:k1')).toBe('recovery_failed');
  });

  it('resumes from the journal after a crash (does not re-run completed steps)', async () => {
    // 第一轮：在 snapshot 之后（migrate）失败，已持久化到 migrating 之前的检查点。
    const first = fakeAdapter({ failAt: 'migrate' });
    const { engine: engine1, journal } = engineFor(first.adapter);
    const r1 = await engine1.run(task());
    expect(r1.phase).toBe('recovered');

    // 模拟重启：新一轮从日志续跑。因为上次停在 recovering，引擎直接走恢复。
    const second = fakeAdapter();
    const lock2 = new ExecutorLock({ filePath: path.join(root, 'executor.lock'), owner: 'test:1' });
    const engine2 = new UpdateEngine({
      adapter: second.adapter,
      journal,
      lock: lock2,
      workDir: path.join(root, 'work'),
    });
    const r2 = await engine2.run(task());
    expect(r2.phase).toBe('recovered');
    // 续跑不重新执行已完成的下载/迁移主路径（download 不在新一轮调用中）。
    expect(second.calls).not.toContain('download');
  });

  it('does not re-run a task that already reached a terminal phase', async () => {
    const { adapter, calls } = fakeAdapter();
    const { engine } = engineFor(adapter);
    await engine.run(task());
    const rerun = await engine.run(task());
    expect(rerun.phase).toBe('committed');
    // 第二次运行没有再次调用适配器（幂等）。
    expect(calls.filter((c) => c === 'download')).toHaveLength(1);
  });

  it('stops mutating once the executor lock is taken over', async () => {
    const { adapter, calls } = fakeAdapter();
    let now = new Date('2026-10-17T00:00:00Z');
    const journal = new FileUpdateJournal(path.join(root, 'journal.jsonl'));
    const lock = new ExecutorLock({
      filePath: path.join(root, 'executor.lock'),
      owner: 'test:1',
      now: () => now,
    });
    const engine = new UpdateEngine({ adapter, journal, lock, workDir: path.join(root, 'work') });

    // 在 download 之后、preflight 之前让锁被接管。
    const original = adapter.preflight.bind(adapter);
    adapter.preflight = vi.fn(async (ctx: StepContext) => {
      now = new Date('2026-10-17T00:10:00Z');
      const b = new ExecutorLock({
        filePath: path.join(root, 'executor.lock'),
        owner: 'other:9',
        now: () => now,
      });
      await b.acquire();
      return original(ctx);
    });

    const result = await engine.run(task());
    expect(result.phase).toBe('recovery_failed');
    // 接管发生在 preflight，之后的 quiesce/snapshot/migrate 绝不能被执行。
    expect(calls).not.toContain('quiesce');
    expect(calls).not.toContain('migrate');
  });
});
