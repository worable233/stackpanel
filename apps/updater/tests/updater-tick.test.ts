/**
 * `Updater.tick()` 的编排回归（执行权 × 通道顺序）。
 *
 * 这两个缺陷都只在**多副本**或**进程被杀**时出现，单副本 happy path 完全看不出来：
 *
 * 1. 回收孤儿任务发生在拿锁之前 → 会把另一个副本正在跑的任务抢回队列；
 * 2. `ExecutorLockError` 未捕获 → 等待方进程直接崩溃。
 *
 * 这里用真实 `ExecutorLock` / `FileUpdateTaskChannel`（临时目录），只把
 * `DeploymentAdapter` 换成假实现，因此覆盖的正是「锁与通道如何配合」这一段。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateTask } from '@stackpanel/spec';
import type { DeploymentAdapter, StepContext } from '../src/deployment-adapter.ts';
import { Updater } from '../src/main.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-tick-'));
});

function task(overrides: Partial<UpdateTask> = {}): UpdateTask {
  return {
    protocolVersion: 1,
    instanceId: 'sp',
    baselineGeneration: 0,
    targetDigest: 'sha256:' + 'a'.repeat(64),
    planDigest: 'plan',
    idempotencyKey: 'k1',
    policyVersion: 1,
    plan: {
      kernel: {
        version: '0.2.1',
        digest: 'sha256:' + 'a'.repeat(64),
        migration: 'm1',
      },
      packages: [],
      planDigestInput: {
        kernelVersion: '0.2.1',
        packages: [],
        frontendAbi: '1',
        schemaRange: '*',
      },
    },
    createdAt: '2026-10-17T00:00:00Z',
    ...overrides,
  };
}

/** 只实现 tick 会碰到的步骤；其余抛出（测试里不应走到）。 */
function adapter(onSwitch?: () => void): DeploymentAdapter {
  const ok = async (): Promise<{ credential: string }> => ({ credential: 'ok' });
  return {
    download: ok,
    preflight: ok,
    quiesce: ok,
    snapshot: async () => ({ credential: 'snap', backupRef: '/tmp/snap' }),
    migrate: ok,
    switchTo: async (_ctx: StepContext) => {
      onSwitch?.();
      return { credential: 'switched' };
    },
    verify: ok,
    commit: ok,
    cleanup: ok,
    recover: async () => ({ recovered: true, credential: 'rec', detail: 'ok' }),
  } as DeploymentAdapter;
}

function makeUpdater(stateDir: string, dep: DeploymentAdapter, owner: string): Updater {
  return new Updater({
    config: {
      stateDir,
      instanceId: 'sp',
      composeProject: 'sp',
      pollIntervalMs: 1,
    },
    adapter: dep,
    log: () => {},
    owner,
  });
}

/** 写入一个「已认领但无结果」的任务，模拟进程中途被杀。 */
async function seedOrphan(stateDir: string, t: UpdateTask): Promise<void> {
  const claimed = path.join(stateDir, 'channel', 'claimed', t.instanceId);
  await import('node:fs/promises').then(({ mkdir }) => mkdir(claimed, { recursive: true }));
  await writeFile(path.join(claimed, `${t.idempotencyKey}.json`), JSON.stringify(t), 'utf8');
}

describe('Updater.tick — 执行权与通道的顺序', () => {
  it('does not touch the channel while another replica holds the lock', async () => {
    // 另一副本持锁：本进程必须**完全不碰** claimed/，否则会把对方正在跑的任务
    // 抢回 inbox（真机双执行器演练抓到的互相踩踏）。
    // 模拟另一个副本已持锁（用同一个锁文件、不同 owner）。
    const { ExecutorLock } = await import('../src/executor-lock.ts');
    const otherLock = new ExecutorLock({
      filePath: path.join(root, 'executor.lock'),
      owner: 'replica-b:1',
    });
    await otherLock.acquire();

    const t = task();
    await seedOrphan(root, t);

    const mine = makeUpdater(root, adapter(), 'replica-a:1');
    const handled = await mine.tick();

    expect(handled).toBe(false);
    // 孤儿任务必须原封不动留在 claimed（另一个副本正在执行它）。
    expect(existsSync(path.join(root, 'channel', 'claimed', 'sp', 'k1.json'))).toBe(true);
    expect(existsSync(path.join(root, 'channel', 'inbox', 'sp', 'k1.json'))).toBe(false);
    await otherLock.release();
  });

  it('reclaims a genuine orphan and resumes from the checkpoint log', async () => {
    // 真孤儿（没有活进程持锁）：应当被回收、认领，并从断点继续，
    // 而不是从头把已经完成的步骤再跑一遍。
    const t = task();
    await seedOrphan(root, t);
    // 模拟「迁移已完成，进程在 switching 前被杀」。
    const journal = path.join(root, 'update-journal.jsonl');
    const entries = [
      ['queued', 'k1'],
      ['resolving', 'plan'],
      ['downloading', 'sha256:aa'],
      ['verified', 'plan'],
      ['preflight', 'gen=0'],
      ['quiescing', 'worker,web'],
      ['snapshotting', 'snap'],
      ['migrating', 'm1'],
    ].map(([phase, credential], index) =>
      JSON.stringify({
        // seq 必须存在：日志读取会丢弃没有 seq 的行（防止半写记录），
        // 少了它检查点就不生效，测试会误以为「从头重跑」是正常行为。
        seq: index + 1,
        at: '2026-10-17T00:00:00Z',
        instanceId: 'sp',
        taskKey: 'sp:k1',
        phase,
        inputDigest: 'plan',
        credential,
      }),
    );
    await writeFile(journal, `${entries.join('\n')}\n`, 'utf8');

    const switched = vi.fn();
    const updater = makeUpdater(root, adapter(switched), 'replica-a:1');
    const handled = await updater.tick();

    expect(handled).toBe(true);
    // 断点续跑：只执行剩下的步骤，切换恰好一次。
    expect(switched).toHaveBeenCalledTimes(1);
    const raw = await readFile(path.join(root, 'channel', 'results', 'sp', 'k1.json'), 'utf8');
    expect(JSON.parse(raw).phase).toBe('committed');
    // 迁移没有重跑：日志里 migrating 仍只有一条。
    const phases = (await readFile(journal, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).phase as string);
    expect(phases.filter((p) => p === 'migrating')).toHaveLength(1);
  });

  it('returns false and releases the lock when there is no work', async () => {
    const updater = makeUpdater(root, adapter(), 'replica-a:1');
    expect(await updater.tick()).toBe(false);
    // 没活干就不该占着锁，否则别的副本永远等不到。
    expect(existsSync(path.join(root, 'executor.lock'))).toBe(false);
  });
});

describe('Updater.run — 自升级失败不得打死执行器', () => {
  /**
   * 真机缺陷：`run()` 里 `guardTick()` / `consumeRequest()` / `settleOnStart()` 的异常
   * 没人接。一次自升级失败（当时是「读不到当前镜像引用」）抛出后进程非零退出，容器按
   * `restart` 策略反复重启，每轮重启又撞同一个错误——一个本应「下次再试」的失败被放大成
   * 全实例不可用，连内核升级都做不了。
   */
  it('keeps ticking after a self-update step throws', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-selfloop-'));
    const logs: string[] = [];
    let consumeCalls = 0;
    const updater = new Updater({
      config: { stateDir: dir, instanceId: 'sp', composeProject: 'sp', pollIntervalMs: 1 },
      adapter: adapter(),
      log: (m) => logs.push(m),
      owner: 'test:run',
      sleep: async () => {
        updater.stop();
      },
      selfUpdate: {
        confirmCandidate: async () => undefined,
        settleOnStart: async () => undefined,
        guardTick: async () => {
          throw new Error('自升级守卫炸了');
        },
        consumeRequest: async () => {
          consumeCalls += 1;
          throw new Error('自升级消费炸了');
        },
      },
    });
    await updater.run();
    expect(consumeCalls).toBe(1);
    expect(logs.some((m) => m.includes('自升级 guard 失败'))).toBe(true);
    expect(logs.some((m) => m.includes('自升级 consume 失败'))).toBe(true);
  });
});
