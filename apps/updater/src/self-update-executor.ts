/**
 * updater 自升级执行（PLAN-github-distribution-and-updates §5.2「updater 自身的更新」）。
 *
 * 硬性要求：
 * - updater 自己的更新**单独执行**，不与内核迁移同时进行（有在途升级任务时拒绝）。
 * - 候选 updater **先验证协议/日志格式兼容**，旧实例**明确停止并释放执行权**后才接管；
 *   本模块复用 {@link ./self-update.ts} 的交接判定，绝不「先接管、事后发现读不懂日志」。
 * - 守护层失败重启；**候选启动失败恢复上一 updater digest**。因为切换镜像后原进程已不在，
 *   恢复必须由**独立于被升级服务**的守护者完成，故这里把「切换 → 等待候选确认 → 超时回退」
 *   做成一个可单测的状态机（{@link SelfUpdateExecutor}），真实 Docker 切换经可注入的
 *   {@link SelfUpdateAdapter}。
 *
 * 状态文件（updater 独立卷）承载跨进程事实：切换前写 `switching`，候选启动成功后写
 * `committed`；守护者据此判断是否超时回退。全部字段可持久、可重读，不凭内存猜测。
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assessHandover, type HandoverRequest } from './self-update.ts';
import { JOURNAL_FORMAT_VERSION } from './self-update.ts';
import { UPDATE_PROTOCOL_VERSION } from '@stackpanel/spec';

/** 自升级阶段。 */
export type SelfUpdatePhase = 'switching' | 'committed' | 'rolled_back';

export interface SelfUpdatePlan {
  phase: SelfUpdatePhase;
  /** 候选 updater 镜像（`repo@sha256:...`）。 */
  candidateDigest: string;
  /** 切换前的 updater 镜像，供候选启动失败时回退。 */
  previousDigest: string;
  /** 切换到候选的时刻（ISO）。 */
  switchedAt: string;
  /** 候选在此刻前未确认即回退（ISO）。 */
  deadlineAt: string;
  updatedAt: string;
}

/** 自升级宿主交互契约（真实实现调用 docker/compose；测试注入假实现）。 */
export interface SelfUpdateAdapter {
  /** 当前运行的 updater 镜像引用。 */
  currentUpdaterImage(): Promise<string>;
  /** 拉取并校验候选 updater 镜像；返回实际引用。 */
  pullAndVerifyUpdater(digest: string): Promise<{ credential: string }>;
  /** 把 updater 服务切到候选镜像。 */
  switchUpdaterTo(digest: string): Promise<{ credential: string }>;
  /** 把 updater 服务恢复/回退到指定镜像。 */
  restoreUpdater(digest: string): Promise<{ credential: string }>;
}

export class SelfUpdateError extends Error {}

/** 文件式自升级计划（updater 独立卷）。 */
export class FileSelfUpdatePlan {
  constructor(private readonly filePath: string) {}

  async read(): Promise<SelfUpdatePlan | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as SelfUpdatePlan;
      return typeof parsed.phase === 'string' && typeof parsed.candidateDigest === 'string'
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  async write(plan: SelfUpdatePlan): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(plan, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  static resolve(stateDir: string): FileSelfUpdatePlan {
    return new FileSelfUpdatePlan(path.join(stateDir, 'self-update-plan.json'));
  }
}

/** 自升级请求（内核/管理端写入共享卷，updater 观察到后执行）。 */
export interface SelfUpdateRequest {
  /** 候选 updater 镜像摘要（`sha256:...` 或裸 hex）。 */
  candidateDigest: string;
  requestedBy: string;
  requestedAt: string;
}

/** 文件式自升级请求：与任务通道对称，管理端写入、updater 观察并消费。 */
export class FileSelfUpdateRequest {
  constructor(private readonly filePath: string) {}

  async read(): Promise<SelfUpdateRequest | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as SelfUpdateRequest;
      return typeof parsed.candidateDigest === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  async write(request: SelfUpdateRequest): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(request, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  static resolve(stateDir: string): FileSelfUpdateRequest {
    return new FileSelfUpdateRequest(path.join(stateDir, 'self-update-request.json'));
  }
}

/** 自升级执行依赖：可注入的适配器、计划存储、当前是否有在途任务、时钟。 */
export interface SelfUpdateExecutorDeps {
  adapter: SelfUpdateAdapter;
  plan: FileSelfUpdatePlan;
  /** 是否存在在途升级任务（自升级不得与内核迁移并行）。 */
  hasActiveTask: () => Promise<boolean>;
  /** 自升级请求存储（管理端写入，updater 消费）。缺省不消费请求。 */
  request?: FileSelfUpdateRequest;
  /** 写入交接请求，通知任何旧写入者在兼容时释放执行权。 */
  requestHandover?: (request: HandoverRequest) => Promise<void>;
  now?: () => Date;
  /** 候选确认窗口（毫秒），默认 5 分钟。 */
  candidateTimeoutMs?: number;
  writerId?: string;
  log?: (message: string) => void;
}

const DEFAULT_CANDIDATE_TIMEOUT_MS = 5 * 60_000;

export type SelfUpdateResult =
  | { status: 'switched'; candidateDigest: string; previousDigest: string }
  | { status: 'committed'; candidateDigest: string }
  | { status: 'rolled_back'; restoredDigest: string; reason: string }
  | { status: 'waiting'; candidateDigest: string; deadlineAt: string }
  | { status: 'idle' };

/**
 * 自升级状态机。所有副作用经 {@link SelfUpdateAdapter}，因此可在不碰真实 Docker 的情况下
 * 覆盖：拒绝并行、切换、候选确认、超时回退四条路径。
 */
export class SelfUpdateExecutor {
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(private readonly deps: SelfUpdateExecutorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs = deps.candidateTimeoutMs ?? DEFAULT_CANDIDATE_TIMEOUT_MS;
  }

  /**
   * 发起自升级：拒绝与内核迁移并行；拉取校验候选、记录回退点、切换镜像、请求交接。
   * 调用方随后应释放执行权并停止（由守护者/候选接管）。
   */
  async requestUpdate(candidateDigest: string): Promise<SelfUpdateResult> {
    if (await this.deps.hasActiveTask()) {
      throw new SelfUpdateError('存在在途升级任务，拒绝在执行内核迁移时自升级（§5.2）');
    }
    const current = await this.deps.adapter.currentUpdaterImage();
    if (imagesMatch(current, candidateDigest)) {
      throw new SelfUpdateError('候选 updater 与当前镜像相同，无需自升级');
    }
    await this.deps.adapter.pullAndVerifyUpdater(candidateDigest);
    const now = this.now();
    const plan: SelfUpdatePlan = {
      phase: 'switching',
      candidateDigest,
      previousDigest: current,
      switchedAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + this.timeoutMs).toISOString(),
      updatedAt: now.toISOString(),
    };
    // 先写回退点，再切换：即便切换后旧进程立即消失，守护者也能读到 previousDigest。
    await this.deps.plan.write(plan);
    await this.deps.adapter.switchUpdaterTo(candidateDigest);
    await this.deps.requestHandover?.({
      requestedBy: this.deps.writerId ?? 'self-update',
      protocolVersion: UPDATE_PROTOCOL_VERSION,
      journalFormatVersion: JOURNAL_FORMAT_VERSION,
      requestedAt: now.toISOString(),
    });
    this.deps.log?.(`自升级已切换到候选 ${candidateDigest}，等待候选确认`);
    return { status: 'switched', candidateDigest, previousDigest: current };
  }

  /**
   * 候选自身启动后调用：确认自己是计划中的候选且协议兼容 → 标记 `committed`。
   * 非候选或计划缺失则返回 `idle`（不误判）。
   */
  async confirmCandidate(): Promise<SelfUpdateResult> {
    const plan = await this.deps.plan.read();
    if (!plan || plan.phase !== 'switching') return { status: 'idle' };
    const current = await this.deps.adapter.currentUpdaterImage();
    if (!imagesMatch(current, plan.candidateDigest)) return { status: 'idle' };
    // 协议/日志格式兼容由 assessHandover 统一裁定（同一来源，避免两套判定漂移）。
    const decision = assessHandover({
      request: {
        requestedBy: this.deps.writerId ?? 'self-update',
        protocolVersion: UPDATE_PROTOCOL_VERSION,
        journalFormatVersion: JOURNAL_FORMAT_VERSION,
        requestedAt: this.now().toISOString(),
      },
      currentOwner: plan.previousDigest,
    });
    if (!decision.allow) {
      throw new SelfUpdateError(`候选不自确认：${decision.reason}`);
    }
    await this.deps.plan.write({
      ...plan,
      phase: 'committed',
      updatedAt: this.now().toISOString(),
    });
    this.deps.log?.('候选 updater 已确认接管，自升级提交');
    return { status: 'committed', candidateDigest: plan.candidateDigest };
  }

  /**
   * 守护者轮询：计划处于 `switching` 且已过截止仍未确认 → 回退到上一镜像并标记
   * `rolled_back`。未超时返回 `waiting`；其它阶段返回 `idle`。
   */
  async guardTick(): Promise<SelfUpdateResult> {
    const plan = await this.deps.plan.read();
    if (!plan || plan.phase !== 'switching') return { status: 'idle' };
    if (this.now().getTime() <= Date.parse(plan.deadlineAt)) {
      return {
        status: 'waiting',
        candidateDigest: plan.candidateDigest,
        deadlineAt: plan.deadlineAt,
      };
    }
    const reason = '候选 updater 未在截止前确认启动，回退上一镜像（§5.2）';
    await this.deps.adapter.restoreUpdater(plan.previousDigest);
    await this.deps.plan.write({
      ...plan,
      phase: 'rolled_back',
      updatedAt: this.now().toISOString(),
    });
    this.deps.log?.(`自升级回退：${plan.previousDigest}`);
    return { status: 'rolled_back', restoredDigest: plan.previousDigest, reason };
  }

  /** 启动时判定：若本进程正是已提交候选，清理计划（幂等）。 */
  async settleOnStart(): Promise<SelfUpdateResult> {
    const plan = await this.deps.plan.read();
    if (!plan) return { status: 'idle' };
    const current = await this.deps.adapter.currentUpdaterImage();
    if (plan.phase === 'committed' && imagesMatch(current, plan.candidateDigest)) {
      await this.deps.plan.clear();
      return { status: 'committed', candidateDigest: plan.candidateDigest };
    }
    return { status: 'idle' };
  }

  /**
   * 消费一条自升级请求（内核/管理端写入共享卷）：无在途计划时执行，执行后清理请求。
   * 有在途计划或存在待执行任务时保留请求，留待下一轮（不丢、不并行）。
   */
  async consumeRequest(): Promise<SelfUpdateResult> {
    if (!this.deps.request) return { status: 'idle' };
    const existing = await this.deps.plan.read();
    if (existing && existing.phase === 'switching') return { status: 'idle' };
    const request = await this.deps.request.read();
    if (!request) return { status: 'idle' };
    if (await this.deps.hasActiveTask()) return { status: 'idle' };
    await this.deps.request.clear();
    return this.requestUpdate(request.candidateDigest);
  }
}

function normalize(digest: string): string {
  return digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
}

/**
 * 判断镜像引用与候选摘要是否指向同一镜像。候选可能是裸 `sha256:...`，而运行时现场可能是
 * `repo@sha256:...`；只要两者的 sha256 相同即视为同一镜像。
 */
export function imagesMatch(reference: string, digest: string): boolean {
  const refDigest = reference.match(/sha256:[0-9a-f]{64}/)?.[0];
  const wantDigest = normalize(digest).match(/sha256:[0-9a-f]{64}/)?.[0];
  if (refDigest && wantDigest) return refDigest === wantDigest;
  return normalize(reference) === normalize(digest);
}
