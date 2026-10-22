/**
 * updater 自升级请求（PLAN-github-distribution-and-updates §5.2「updater 自己的更新」）。
 *
 * updater 的执行核心（`apps/updater/src/self-update-executor.ts`）已经齐备：拒绝与在途
 * 迁移并行、先写回退点再切换、候选自确认、超时回退、启动结算。但它**只读**共享卷上的
 * `self-update-request.json`——此前内核侧没有任何代码写这个文件，于是「谁来发起」这一环
 * 是空的：执行能力存在，生产路径不可达。
 *
 * 本模块补上写入方，并把前置条件集中在这里（而不是散在路由里）：
 * - 只接受**裸 sha256 hex** 或 `repo@sha256:…` / `sha256:…`，最终统一收敛成裸 hex，
 *   与升级任务的 `targetDigest` 同一形态；
 * - 有在途升级任务（`status.activeTask`）或已有未消费请求时拒绝，避免与内核迁移叠加；
 * - 原子写（tmp + rename），updater 不会读到半写文件。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digestHex } from '@stackpanel/spec';
import { readUpdaterStatus, setUpdaterStateDirForTest, updaterStateDir } from './status.ts';

/** 与 updater `FileSelfUpdateRequest` 同形的请求体。 */
export interface SelfUpdateRequestFile {
  candidateDigest: string;
  requestedBy: string;
  requestedAt: string;
}

/** 测试用：覆盖 updater 状态卷根；不传则清除覆盖。 */
export function setSelfUpdateStateDirForTest(dir: string | null): void {
  setUpdaterStateDirForTest(dir);
}

/** `self-update-request.json` 的绝对路径（updater 侧同一个文件名，同一个卷）。 */
export function selfUpdateRequestPath(): string {
  return path.join(updaterStateDir(), 'self-update-request.json');
}

export class SelfUpdateRequestError extends Error {
  constructor(
    message: string,
    readonly kind: 'invalid-digest' | 'busy' | 'pending' | 'io',
  ) {
    super(message);
  }
}

/** 读取尚未被 updater 消费的请求（仅供更新中心展示）。 */
export async function readSelfUpdateRequest(): Promise<SelfUpdateRequestFile | null> {
  try {
    const parsed = JSON.parse(
      await readFile(selfUpdateRequestPath(), 'utf8'),
    ) as Partial<SelfUpdateRequestFile>;
    return typeof parsed.candidateDigest === 'string'
      ? {
          candidateDigest: parsed.candidateDigest,
          requestedBy: typeof parsed.requestedBy === 'string' ? parsed.requestedBy : 'unknown',
          requestedAt: typeof parsed.requestedAt === 'string' ? parsed.requestedAt : '',
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * 提交一次 updater 自升级请求。
 *
 * 只写请求文件，**不**在这里切换镜像——真正执行由 updater 在空闲时
 * `consumeRequest()` 完成（有在途任务时保留、不丢）。
 */
export async function submitSelfUpdateRequest(input: {
  candidateDigest: string;
  requestedBy: string;
  now?: Date;
}): Promise<{ request: SelfUpdateRequestFile; path: string }> {
  const digest = digestHex(input.candidateDigest);
  if (!digest) {
    throw new SelfUpdateRequestError(
      '候选 updater 摘要格式无效：需要 64 位 sha256 hex，或 repo@sha256:… / sha256:…',
      'invalid-digest',
    );
  }
  const status = await readUpdaterStatus();
  if (status?.activeTask) {
    throw new SelfUpdateRequestError(
      `存在在途升级任务（${status.activeTask}），拒绝与内核迁移同时自升级`,
      'busy',
    );
  }
  const pending = await readSelfUpdateRequest();
  if (pending && pending.candidateDigest !== digest) {
    throw new SelfUpdateRequestError(
      '已有一个待执行的 updater 自升级请求，需等 updater 消费或先撤销',
      'pending',
    );
  }
  const request: SelfUpdateRequestFile = {
    candidateDigest: digest,
    requestedBy: input.requestedBy,
    requestedAt: (input.now ?? new Date()).toISOString(),
  };
  const target = selfUpdateRequestPath();
  try {
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(request, null, 2), 'utf8');
    await rename(tmp, target);
  } catch (err) {
    throw new SelfUpdateRequestError(
      `写入自升级请求失败：${err instanceof Error ? err.message : String(err)}`,
      'io',
    );
  }
  return { request, path: target };
}

/**
 * 撤销尚未被消费的自升级请求。
 *
 * 只删请求文件——已经切换到候选后的回退由 updater 的守护者负责（`self-update-plan.json`），
 * 内核不该越权改那个状态文件。返回是否真的删掉了东西。
 */
export async function clearSelfUpdateRequest(): Promise<boolean> {
  const target = selfUpdateRequestPath();
  try {
    await rm(target, { force: true });
    return true;
  } catch {
    return false;
  }
}
