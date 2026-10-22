import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateTask } from '@stackpanel/spec';
import { FileUpdateJournal } from '../src/journal.ts';
import { ExecutorLock, ExecutorLockError } from '../src/executor-lock.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-updater-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FileUpdateJournal', () => {
  it('appends with monotonic seq and reads back per task', async () => {
    const journal = new FileUpdateJournal(path.join(root, 'j.jsonl'));
    await journal.append({
      at: '2026-10-17T00:00:00Z',
      instanceId: 'i1',
      taskKey: 'i1:k1',
      phase: 'queued',
      inputDigest: 'd',
    });
    await journal.append({
      at: '2026-10-17T00:01:00Z',
      instanceId: 'i1',
      taskKey: 'i1:k1',
      phase: 'resolving',
      inputDigest: 'd',
      credential: 'plan',
    });
    await journal.append({
      at: '2026-10-17T00:02:00Z',
      instanceId: 'i1',
      taskKey: 'i1:k2',
      phase: 'queued',
      inputDigest: 'd2',
    });
    const task = await journal.forTask('i1:k1');
    expect(task.map((e) => e.seq)).toEqual([1, 2]);
    expect(task[1]?.credential).toBe('plan');
    expect(await journal.latestPhase('i1:k1')).toBe('resolving');
  });

  it('tolerates a torn trailing line (power loss) without losing prior records', async () => {
    const file = path.join(root, 'torn.jsonl');
    await writeFile(
      file,
      '{"seq":1,"at":"2026-10-17T00:00:00Z","instanceId":"i1","taskKey":"i1:k1","phase":"queued","inputDigest":"d"}\n{"seq":2,"at":"2026-10-1',
      'utf8',
    );
    const journal = new FileUpdateJournal(file);
    const entries = await journal.entries();
    expect(entries.map((e) => e.seq)).toEqual([1]);
    // 新追加的 seq 从已持久化的最高值继续，不覆盖旧记录。
    const next = await journal.append({
      at: '2026-10-17T00:05:00Z',
      instanceId: 'i1',
      taskKey: 'i1:k1',
      phase: 'verifying',
      inputDigest: 'd',
    });
    expect(next.seq).toBe(2);
  });
});

describe('ExecutorLock', () => {
  it('grants exclusive ownership and rejects a second live owner', async () => {
    const filePath = path.join(root, 'executor.lock');
    const a = new ExecutorLock({ filePath, owner: 'a:1' });
    const b = new ExecutorLock({ filePath, owner: 'b:2' });
    const genA = await a.acquire();
    expect(genA).toBe(1);
    await expect(b.acquire()).rejects.toBeInstanceOf(ExecutorLockError);
  });

  it('lets a stale lock be taken over and stops the old owner from writing', async () => {
    const filePath = path.join(root, 'executor.lock');
    let now = new Date('2026-10-17T00:00:00Z');
    const a = new ExecutorLock({ filePath, owner: 'a:1', now: () => now });
    await a.acquire();
    // 10 分钟后 a 的心跳已过期，b 接管。
    now = new Date('2026-10-17T00:10:00Z');
    const b = new ExecutorLock({ filePath, owner: 'b:2', now: () => now, staleAfterMs: 60_000 });
    const genB = await b.acquire();
    expect(genB).toBe(2);
    // a 在变更边界处 assertOwned 会失败（必须停手）。
    await expect(a.assertOwned()).rejects.toThrow(/失去执行权/);
    await expect(b.assertOwned()).resolves.toBeUndefined();
  });

  it('does not delete a successor lock on release', async () => {
    const filePath = path.join(root, 'executor.lock');
    let now = new Date('2026-10-17T00:00:00Z');
    const a = new ExecutorLock({ filePath, owner: 'a:1', now: () => now });
    await a.acquire();
    now = new Date('2026-10-17T00:10:00Z');
    const b = new ExecutorLock({ filePath, owner: 'b:2', now: () => now });
    await b.acquire();
    await a.release(); // a 已不是持有者 → 不删 b 的锁
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { owner: string };
    expect(raw.owner).toBe('b:2');
  });
});

describe('FileUpdateTaskChannel', () => {
  function task(overrides: Partial<UpdateTask> = {}): UpdateTask {
    return {
      protocolVersion: 1,
      instanceId: 'i1',
      baselineGeneration: 3,
      targetDigest: 'sha256:' + 'a'.repeat(64),
      planDigest: 'p',
      idempotencyKey: 'k1',
      policyVersion: 1,
      plan: {
        kernel: { version: '0.3.0', digest: 'sha256:' + 'a'.repeat(64), migration: 'm1' },
        packages: [],
        planDigestInput: {
          kernelVersion: '0.3.0',
          packages: [],
          frontendAbi: '1',
          schemaRange: '*',
        },
      },
      createdAt: '2026-10-17T00:00:00Z',
      ...overrides,
    };
  }

  it('submits idempotently and claims exactly once', async () => {
    const { FileUpdateTaskChannel } = await import('../src/task-channel.ts');
    const channel = new FileUpdateTaskChannel(path.join(root, 'channel'));
    await channel.submit(task());
    await channel.submit(task({ idempotencyKey: 'k2' }));
    const first = await channel.claim('i1');
    const second = await channel.claim('i1');
    expect(first?.idempotencyKey).toBe('k1');
    expect(second?.idempotencyKey).toBe('k2');
    expect(await channel.claim('i1')).toBeNull();
  });

  it('writes a result projection and clears the claim', async () => {
    const { FileUpdateTaskChannel } = await import('../src/task-channel.ts');
    const channel = new FileUpdateTaskChannel(path.join(root, 'channel'));
    const t = task();
    await channel.submit(t);
    await channel.claim('i1');
    await channel.complete(t, { phase: 'committed', checkpoints: [] });
    const result = JSON.parse(
      await readFile(path.join(root, 'channel', 'results', 'i1', 'k1.json'), 'utf8'),
    ) as { phase: string };
    expect(result.phase).toBe('committed');
  });

  it('reclaims a task whose process died mid-execution (claimed but no result)', async () => {
    // 真机用 `docker kill` 复现：任务从 inbox 移到 claimed 后进程被杀，
    // 结果文件不存在，任务就永久留在 claimed —— 既不续跑也不恢复，
    // 实例卡在维护态。回收后应重新出现在 inbox 并可被认领。
    const { FileUpdateTaskChannel } = await import('../src/task-channel.ts');
    const channel = new FileUpdateTaskChannel(path.join(root, 'channel'));
    const t = task();
    await channel.submit(t);
    const claimed = await channel.claim('i1');
    expect(claimed?.idempotencyKey).toBe('k1');
    // 模拟进程在此刻死亡：claimed/k1.json 存在，results/k1.json 不存在。
    expect(await channel.claim('i1')).toBeNull();

    const orphans = await channel.reclaimOrphans('i1');
    expect(orphans.map((o) => o.idempotencyKey)).toEqual(['k1']);

    // 回收后能被重新认领（这就是「按检查点续跑」的入口）。
    const again = await channel.claim('i1');
    expect(again?.idempotencyKey).toBe('k1');
    expect(again?.plan.kernel.migration).toBe('m1');
  });

  it('does not resurrect a task that already has a result (only cleans the claim)', async () => {
    // 有结果说明任务已正常收尾，只是删认领文件前被杀——重跑会重复执行一次升级。
    const { FileUpdateTaskChannel } = await import('../src/task-channel.ts');
    const channel = new FileUpdateTaskChannel(path.join(root, 'channel'));
    const t = task();
    await channel.submit(t);
    await channel.claim('i1');
    await channel.complete(t, { phase: 'committed', checkpoints: [] });

    const orphans = await channel.reclaimOrphans('i1');
    expect(orphans).toEqual([]);
    expect(await channel.claim('i1')).toBeNull();
  });

  it('archives the full task declaration and reads it back for recovery retry', async () => {
    const { FileUpdateTaskChannel } = await import('../src/task-channel.ts');
    const channel = new FileUpdateTaskChannel(path.join(root, 'channel'));
    const t = task();
    await channel.archiveTask(t);
    // Survives a fresh channel instance (persisted, not in-memory).
    const reopened = new FileUpdateTaskChannel(path.join(root, 'channel'));
    const archived = await reopened.readArchivedTask('i1', 'k1');
    expect(archived?.targetDigest).toBe(t.targetDigest);
    expect(archived?.plan.kernel.migration).toBe('m1');
    expect(await reopened.readArchivedTask('i1', 'missing')).toBeNull();
  });
});
