import { describe, expect, it, vi } from 'vitest';
import { pruneRunTokens } from '../../src/agent/background.ts';
import { RUN_TOKEN_AUDIENCE } from '../../src/agent/run-token.ts';

/**
 * 会话代签的短期 `agent-run` 令牌必须被清掉。
 *
 * 每条从抽屉发出的消息都会在 `createRun` 里新建一枚 5 分钟有效期的令牌
 * （`AgentRun.tokenId` 非空，运行必须挂在凭证上）。这些令牌**没有别的地方会删**：
 * `resolveApiTokenWithOwner` 只拒绝过期令牌不删行，`/me/api-tokens` 不列它们，
 * 系统里唯一的 `apiToken.deleteMany` 是用户主动吊销。于是 `api_tokens` 随对话量
 * 线性增长。
 *
 * 难点在于「过期 ≠ 没人再用」：`expiresAt` 只约束「拿它去新建」的窗口，运行
 * 本身按 owner+status 判定，可以活很久。而 `AgentRun.tokenId` 是
 * `onDelete: Cascade` —— 删错一枚就把运行、步骤、审批的审计轨迹一起抹掉。
 */

type Row = { id: string };

function fakeDb(tokens: Array<{ id: string; audience: string | null; expiresAt: Date | null; runs: Array<{ status: string }> }>) {
  const deleted: string[][] = [];
  const db = {
    apiToken: {
      findMany: async ({ where, take }: { where: Record<string, unknown>; take: number }) => {
        const cutoff = (where.expiresAt as { lt: Date }).lt;
        const rows = tokens
          .filter((t) => t.audience === where.audience)
          .filter((t) => t.expiresAt !== null && t.expiresAt < cutoff)
          // 模拟 `runs: { none: { status: { notIn: [...] } } }`
          .filter((t) => !t.runs.some((run) => !['DONE', 'FAILED', 'CANCELLED'].includes(run.status)));
        return rows.slice(0, take).map((t): Row => ({ id: t.id }));
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        deleted.push(where.id.in);
        return { count: where.id.in.length };
      },
    },
  };
  return { db: db as never, deleted };
}

const now = new Date('2026-01-10T00:00:00Z');
const old = new Date('2026-01-01T00:00:00Z');
const fresh = new Date('2026-01-09T23:59:00Z');

describe('pruneRunTokens', () => {
  it('deletes an expired agent-run token with no live run', async () => {
    const { db, deleted } = fakeDb([
      { id: 't1', audience: RUN_TOKEN_AUDIENCE, expiresAt: old, runs: [{ status: 'DONE' }] },
    ]);
    expect(await pruneRunTokens(db, now)).toBe(1);
    expect(deleted).toEqual([['t1']]);
  });

  it('keeps a token that still owns a live run (cascade would erase the audit trail)', async () => {
    // 后台运行的令牌过期了，但运行还在 RUNNING：删令牌会级联删掉运行与步骤。
    const { db, deleted } = fakeDb([
      { id: 't1', audience: RUN_TOKEN_AUDIENCE, expiresAt: old, runs: [{ status: 'RUNNING' }] },
      { id: 't2', audience: RUN_TOKEN_AUDIENCE, expiresAt: old, runs: [{ status: 'WAITING_APPROVAL' }] },
      { id: 't3', audience: RUN_TOKEN_AUDIENCE, expiresAt: old, runs: [{ status: 'QUEUED' }] },
    ]);
    expect(await pruneRunTokens(db, now)).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('never touches tokens the user created by hand', async () => {
    // 用户自建的长效令牌（audience 为 null）必须留着，哪怕早已过期。
    const { db, deleted } = fakeDb([
      { id: 'user-token', audience: null, expiresAt: old, runs: [] },
    ]);
    expect(await pruneRunTokens(db, now)).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('respects the grace window so a just-expired token is not yanked mid-flight', async () => {
    const { db, deleted } = fakeDb([
      { id: 'recent', audience: RUN_TOKEN_AUDIENCE, expiresAt: fresh, runs: [] },
    ]);
    expect(await pruneRunTokens(db, now)).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('caps the batch so one sweep cannot stall the loop', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      id: `t${i}`,
      audience: RUN_TOKEN_AUDIENCE,
      expiresAt: old,
      runs: [],
    }));
    const { db } = fakeDb(many);
    expect(await pruneRunTokens(db, now)).toBe(200);
  });
});
