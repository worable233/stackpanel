import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clearSelfUpdateRequest,
  readSelfUpdateRequest,
  selfUpdateRequestPath,
  setSelfUpdateStateDirForTest,
  submitSelfUpdateRequest,
  SelfUpdateRequestError,
} from '../../src/updates/self-update.ts';

/**
 * updater 自升级请求的内核侧写入方（PLAN §5.2「updater 自己的更新」）。
 *
 * 执行核心在 `apps/updater`：它会读共享卷上的 `self-update-request.json`，但此前
 * **没有任何生产代码写这个文件**——能力齐备而路径不可达。这里验证补上的写入方：
 * 摘要收敛、在途任务拒绝、请求不重复、原子写、可撤销。
 */

const DIGEST = 'a'.repeat(64);
let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'sp-self-update-'));
  setSelfUpdateStateDirForTest(stateDir);
});

afterEach(async () => {
  setSelfUpdateStateDirForTest(null);
  await rm(stateDir, { recursive: true, force: true });
});

/** 写一份 updater 状态投影，模拟「有在途任务」。 */
async function writeStatus(activeTask: string | null): Promise<void> {
  await writeFile(
    path.join(stateDir, 'status.json'),
    JSON.stringify({
      generation: 1,
      digest: null,
      activeTask,
      recent: [],
      updatedAt: '2026-10-22T00:00:00.000Z',
    }),
    'utf8',
  );
}

describe('submitSelfUpdateRequest', () => {
  it('把裸 hex / sha256: / repo@sha256: 三种形态统一收敛成裸 hex', async () => {
    const bare = await submitSelfUpdateRequest({
      candidateDigest: DIGEST,
      requestedBy: 'admin-1',
    });
    expect(bare.request.candidateDigest).toBe(DIGEST);
    await clearSelfUpdateRequest();

    const prefixed = await submitSelfUpdateRequest({
      candidateDigest: `sha256:${DIGEST}`,
      requestedBy: 'admin-1',
    });
    expect(prefixed.request.candidateDigest).toBe(DIGEST);
    await clearSelfUpdateRequest();

    const reference = await submitSelfUpdateRequest({
      candidateDigest: `ghcr.io/acme/updater@sha256:${DIGEST}`,
      requestedBy: 'admin-1',
    });
    expect(reference.request.candidateDigest).toBe(DIGEST);
  });

  it('写出的文件与 updater 读取端同形（candidateDigest/requestedBy/requestedAt）', async () => {
    await submitSelfUpdateRequest({ candidateDigest: DIGEST, requestedBy: 'admin-1' });
    const raw = JSON.parse(await readFile(selfUpdateRequestPath(), 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({ candidateDigest: DIGEST, requestedBy: 'admin-1' });
    expect(typeof raw['requestedAt']).toBe('string');
    expect(Number.isNaN(Date.parse(raw['requestedAt'] as string))).toBe(false);
  });

  it('拒绝非法摘要（不能把拼错的引用当候选镜像）', async () => {
    await expect(
      submitSelfUpdateRequest({ candidateDigest: 'latest', requestedBy: 'admin-1' }),
    ).rejects.toBeInstanceOf(SelfUpdateRequestError);
  });

  it('有在途升级任务时拒绝——不与内核迁移并行（§5.2）', async () => {
    await writeStatus('update-task-key');
    await expect(
      submitSelfUpdateRequest({ candidateDigest: DIGEST, requestedBy: 'admin-1' }),
    ).rejects.toMatchObject({ kind: 'busy' });
    expect(await readSelfUpdateRequest()).toBeNull();
  });

  it('已有不同候选的待执行请求时拒绝（不覆盖别人提交的请求）', async () => {
    await submitSelfUpdateRequest({ candidateDigest: DIGEST, requestedBy: 'admin-1' });
    await expect(
      submitSelfUpdateRequest({ candidateDigest: 'b'.repeat(64), requestedBy: 'admin-2' }),
    ).rejects.toMatchObject({ kind: 'pending' });
    // 原请求保持不变。
    expect((await readSelfUpdateRequest())?.candidateDigest).toBe(DIGEST);
  });

  it('同一候选重复提交是幂等的（后台重复点按不报错）', async () => {
    await submitSelfUpdateRequest({ candidateDigest: DIGEST, requestedBy: 'admin-1' });
    const again = await submitSelfUpdateRequest({
      candidateDigest: DIGEST,
      requestedBy: 'admin-2',
    });
    expect(again.request.candidateDigest).toBe(DIGEST);
    expect(again.request.requestedBy).toBe('admin-2');
  });
});

describe('clearSelfUpdateRequest', () => {
  it('撤销待执行请求后读取返回 null', async () => {
    await submitSelfUpdateRequest({ candidateDigest: DIGEST, requestedBy: 'admin-1' });
    expect(await clearSelfUpdateRequest()).toBe(true);
    expect(await readSelfUpdateRequest()).toBeNull();
    // 再撤销一次不抛错（force 删除）。
    expect(await clearSelfUpdateRequest()).toBe(true);
  });
});
