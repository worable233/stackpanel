/**
 * updater 自更新与执行权交接（PLAN-github-distribution-and-updates §5.2）。
 *
 * 硬性要求：updater 自身升级**不能只靠 restart 策略**宣称完成——候选实例必须先验证
 * 日志格式与协议兼容，旧实例停止并**释放执行权**后，候选才能接管；否则宁可拒绝接续，
 * 也不能让两个进程或两个不兼容版本同时写同一实例的权威日志。
 *
 * 本模块把交接变成可单测的核心：
 * - 交接请求（候选写入，旧实例观察）与固定的兼容性判定。
 * - 兼容即允许：旧实例看到兼容的接管请求后释放锁并停下。
 * - 不兼容即拒绝：版本不一致时明确原因，不进入接管流程。
 */

import { readFile, rename, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UPDATE_PROTOCOL_VERSION } from '@stackpanel/spec';

/** 权威日志格式版本；日志结构不兼容变更时递增。 */
export const JOURNAL_FORMAT_VERSION = 1;

export interface SelfUpdateState {
  /** 当前写入者的协议版本。 */
  protocolVersion: number;
  /** 当前写入者的日志格式版本。 */
  journalFormatVersion: number;
  /** 写入者标识（`host:pid`）。 */
  writerId: string;
  updatedAt: string;
}

/** 交接请求：候选 updater 声明自己要接管，并声明其版本。 */
export interface HandoverRequest {
  requestedBy: string;
  protocolVersion: number;
  journalFormatVersion: number;
  requestedAt: string;
}

export interface HandoverDecision {
  allow: boolean;
  reason: string;
}

/**
 * 判定是否允许交接。**先验证后接管**：协议或日志格式不兼容一律拒绝，绝不放行
 * 「先接管、事后发现读不懂日志」。
 */
export function assessHandover(input: {
  request: HandoverRequest;
  supportedProtocolVersion?: number;
  supportedJournalFormatVersion?: number;
  currentOwner?: string | null;
}): HandoverDecision {
  const supportedProtocol = input.supportedProtocolVersion ?? UPDATE_PROTOCOL_VERSION;
  const supportedJournal = input.supportedJournalFormatVersion ?? JOURNAL_FORMAT_VERSION;
  const { request } = input;
  if (request.protocolVersion !== supportedProtocol) {
    return {
      allow: false,
      reason: `协议版本不兼容：候选 ${request.protocolVersion} ≠ 本机 ${supportedProtocol}`,
    };
  }
  if (request.journalFormatVersion !== supportedJournal) {
    return {
      allow: false,
      reason: `日志格式不兼容：候选 ${request.journalFormatVersion} ≠ 本机 ${supportedJournal}，拒绝接管`,
    };
  }
  // 同一写入者重复请求视为幂等允许。
  if (input.currentOwner && input.currentOwner === request.requestedBy) {
    return { allow: true, reason: '同一写入者重复请求，幂等允许' };
  }
  return { allow: true, reason: '协议与日志格式兼容，允许在旧实例释放执行权后接管' };
}

/** 文件式交接请求：候选写入，旧实例轮询观察。 */
export class FileHandover {
  constructor(private readonly filePath: string) {}

  async read(): Promise<HandoverRequest | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as HandoverRequest;
      return typeof parsed.requestedBy === 'string' && typeof parsed.protocolVersion === 'number'
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  async write(request: HandoverRequest): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(request, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  static resolve(stateDir: string): FileHandover {
    return new FileHandover(path.join(stateDir, 'handover.json'));
  }
}

/** 文件式自身版本状态：记录当前权威日志的写入者版本，供候选校验。 */
export class FileSelfUpdateState {
  constructor(private readonly filePath: string) {}

  async read(): Promise<SelfUpdateState | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as SelfUpdateState;
      return typeof parsed.protocolVersion === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  async write(state: SelfUpdateState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  static resolve(stateDir: string): FileSelfUpdateState {
    return new FileSelfUpdateState(path.join(stateDir, 'self-update.json'));
  }
}
