import { describe, expect, it, vi } from 'vitest';
import { LlmProviderError } from '@stackpanel/sdk';
import type {
  LlmCallOptions,
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmModelInfo,
  LlmPart,
  LlmProvider,
  McpApiCall,
  McpCapability,
} from '@stackpanel/sdk';
import type { PrismaClient } from '@stackpanel/db';

// The runtime writes an audit row per step through `../plugins/audit.ts`, which
// resolves the real Prisma singleton. These tests are pure in-memory, so the
// audit sink is stubbed — the audit *contract* (real human as actorId + meta.agent)
// is asserted by capturing the calls.
const auditCalls: Array<Record<string, unknown>> = [];
vi.mock('../../src/plugins/audit.ts', () => ({
  auditContext: (): Record<string, unknown> => ({}),
  writeAudit: async (input: Record<string, unknown>): Promise<void> => {
    auditCalls.push(input);
  },
}));

const {
  AGENT_APPROVAL_TTL_MS,
  isModelAllowed,
  resumeAgent,
  runAgentUntilBlocked,
  stepAgent,
  toRunView,
} = await import('../../src/lib/agent-runtime.ts');
import type { AgentRuntimeDeps } from '../../src/lib/agent-runtime.ts';
const { approvalEligibility } = await import('../../src/routes/agent.ts');

/* ------------------------------------------------------------------ *
 * In-memory doubles
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>;
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture');
  return value;
}

/** Minimal Prisma double: only the models/verbs the loop actually uses. */
function fakePrisma() {
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}_${++seq}`;
  const runs = new Map<string, Row>();
  const steps = new Map<string, Row>();
  const approvals = new Map<string, Row>();

  function pick(rows: Row[], where: Row | undefined): Row[] {
    if (!where) return rows;
    return rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
  }

  const prisma = {
    agentRun: {
      create: async ({ data }: { data: Row }): Promise<Row> => {
        const now = new Date();
        const row: Row = {
          id: nextId('run'),
          status: 'QUEUED',
          steps: 0,
          spendMinor: 0,
          tokensIn: 0,
          tokensOut: 0,
          error: null,
          model: null,
          startedAt: null,
          endedAt: null,
          ...data,
          createdAt: now,
        };
        runs.set(row['id'] as string, row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }): Promise<Row> => {
        const row = runs.get(where['id'] as string);
        if (!row) throw new Error('run not found');
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const row = runs.get(where['id'] as string);
        if (!row || ['DONE', 'FAILED', 'CANCELLED'].includes(row['status'] as string))
          return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: Row }): Promise<Row | null> => {
        return runs.get(where['id'] as string) ?? null;
      },
    },
    agentStep: {
      create: async ({ data }: { data: Row }): Promise<Row> => {
        const row: Row = {
          id: nextId('step'),
          createdAt: new Date(),
          costMinor: 0,
          tokensIn: 0,
          tokensOut: 0,
          ...data,
        };
        steps.set(row['id'] as string, row);
        return row;
      },
      findMany: async ({ where, orderBy }: { where: Row; orderBy?: unknown }): Promise<Row[]> => {
        const matched = pick([...steps.values()], where);
        const sorted = matched.sort((a, b) => (a['index'] as number) - (b['index'] as number));
        return orderBy ? sorted : sorted;
      },
    },
    agentApproval: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const row = approvals.get(where['id'] as string);
        if (!row || row['status'] !== where['status']) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      create: async ({ data }: { data: Row }): Promise<Row> => {
        const row: Row = {
          id: nextId('approval'),
          status: 'PENDING',
          decidedBy: null,
          decidedAt: null,
          reason: null,
          createdAt: new Date(),
          ...data,
        };
        approvals.set(row['id'] as string, row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }): Promise<Row> => {
        const row = approvals.get(where['id'] as string);
        if (!row) throw new Error('approval not found');
        Object.assign(row, data);
        return row;
      },
      findFirst: async ({ where }: { where: Row }): Promise<Row | null> => {
        return pick([...approvals.values()], where)[0] ?? null;
      },
      findUnique: async ({ where }: { where: Row }): Promise<Row | null> => {
        return approvals.get(where['id'] as string) ?? null;
      },
    },
  };

  return {
    prisma: prisma as unknown as PrismaClient,
    runs,
    steps,
    approvals,
    stepRows: (): Row[] =>
      [...steps.values()].sort((a, b) => (a['index'] as number) - (b['index'] as number)),
    approvalRows: (): Row[] => [...approvals.values()],
  };
}

/** A scripted provider: each `complete` returns the next canned result. */
function scriptedProvider(script: LlmCompletionResult[]) {
  const calls: Array<{ request: LlmCompletionRequest; options: LlmCallOptions }> = [];
  let index = 0;
  const provider: LlmProvider = {
    id: 'test',
    name: 'test provider',
    listModels: async (): Promise<LlmModelInfo[]> => [],
    complete: async (
      request: LlmCompletionRequest,
      options: LlmCallOptions,
    ): Promise<LlmCompletionResult> => {
      calls.push({ request, options });
      const result = script[index++];
      if (!result) throw new Error('provider script exhausted');
      return result;
    },
  };
  return { provider, calls, seen: (): number => index };
}

function completion(
  parts: LlmPart[],
  stopReason: LlmCompletionResult['stopReason'],
): LlmCompletionResult {
  return {
    model: 'test-model',
    parts,
    stopReason,
    usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    costMinor: 4,
  };
}

function toolCall(id: string, name: string, args: unknown): LlmPart {
  return { type: 'tool-call', id, name, arguments: JSON.stringify(args) };
}

const READ_CAPABILITY: McpCapability = {
  id: 'order.read',
  method: 'GET',
  path: '/api/v1/orders/:id',
  scope: null,
  summary: 'Read one order',
  mutating: false,
};

const WRITE_CAPABILITY: McpCapability = {
  id: 'order.cancel',
  destructive: false,
  method: 'POST',
  path: '/api/v1/orders/:id/cancel',
  scope: null,
  summary: 'Cancel one order',
  mutating: true,
};

/** Executor double: records every call and replies 200 with a JSON body. */
function fakeExecutor() {
  const calls: McpApiCall[] = [];
  const executor = async (
    call: McpApiCall,
  ): Promise<{ statusCode: number; contentType: string; body: string }> => {
    calls.push(call);
    return { statusCode: 200, contentType: 'application/json', body: '{"ok":true}' };
  };
  return { calls, executor };
}

interface Harness {
  deps: AgentRuntimeDeps;
  runs: ReturnType<typeof fakePrisma>['runs'];
  approvalRows: ReturnType<typeof fakePrisma>['approvalRows'];
  stepRows: ReturnType<typeof fakePrisma>['stepRows'];
  exec: ReturnType<typeof fakeExecutor>;
  providerCalls: Array<{ request: LlmCompletionRequest; options: LlmCallOptions }>;
}

async function harness(options: {
  script: LlmCompletionResult[];
  capabilities?: McpCapability[];
  autonomy?: AgentRuntimeDeps['autonomy'];
  maxSteps?: number;
  budgetMinor?: number;
  allowedModels?: string[];
  model?: string;
  grantedScopes?: ReadonlySet<string> | null;
}): Promise<Harness> {
  const store = fakePrisma();
  const { provider, calls } = scriptedProvider(options.script);
  const exec = fakeExecutor();
  const run = await store.prisma.agentRun.create({
    data: {
      actorId: 'user_actor',
      tokenId: 'token_1',
      objective: '帮我查一下订单',
      status: 'QUEUED',
      model: options.model ?? 'test-model',
      startedAt: new Date(),
    },
  });
  const deps: AgentRuntimeDeps = {
    prisma: store.prisma,
    provider,
    capabilities: options.capabilities ?? [READ_CAPABILITY, WRITE_CAPABILITY],
    executor: exec.executor,
    actorId: 'user_actor',
    tokenId: 'token_1',
    runId: run['id'] as string,
    objective: '帮我查一下订单',
    model: options.model ?? 'test-model',
    autonomy: options.autonomy ?? 'read',
    maxSteps: options.maxSteps ?? 20,
    budgetMinor: options.budgetMinor ?? 0,
    allowedModels: options.allowedModels ?? [],
    grantedScopes: options.grantedScopes ?? null,
  };
  return {
    deps,
    runs: store.runs,
    approvalRows: store.approvalRows,
    stepRows: store.stepRows,
    exec,
    providerCalls: calls,
  };
}

/* ------------------------------------------------------------------ *
 * Loop behaviour
 * ------------------------------------------------------------------ */

describe('kernel agent runtime', () => {
  it('executes a read-only capability directly and finishes DONE', async () => {
    const h = await harness({
      script: [
        completion([toolCall('c1', 'order_read', { params: { id: 'o_1' } })], 'tool_calls'),
        completion([{ type: 'text', text: '订单已查到' }], 'stop'),
      ],
    });

    const view = await runAgentUntilBlocked(h.deps);

    expect(view.status).toBe('DONE');
    expect(h.exec.calls).toHaveLength(1);
    expect(h.exec.calls[0]).toMatchObject({ method: 'GET', path: '/api/v1/orders/o_1' });
    const kinds = h.stepRows().map((step) => step['kind']);
    expect(kinds).toContain('assistant');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_result');
    expect(h.stepRows().find((step) => step['kind'] === 'tool_result')?.['isError']).toBe(false);
  });

  it('parks a mutating capability for approval under autonomy=read and NEVER calls the executor', async () => {
    const h = await harness({
      script: [
        completion([toolCall('c1', 'order_cancel', { params: { id: 'o_1' } })], 'tool_calls'),
      ],
      autonomy: 'read',
    });

    const view = await runAgentUntilBlocked(h.deps);

    expect(view.status).toBe('WAITING_APPROVAL');
    expect(h.exec.calls).toHaveLength(0);
    const approvals = h.approvalRows();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.['status']).toBe('PENDING');
    expect(approvals[0]?.['capabilityId']).toBe('order.cancel');
    const approvalStep = h.stepRows().find((step) => step['kind'] === 'approval');
    expect(approvalStep?.['approvalId']).toBe(approvals[0]?.['id']);
  });

  it('executes a mutating capability directly under autonomy=act', async () => {
    const h = await harness({
      script: [
        completion([toolCall('c1', 'order_cancel', { params: { id: 'o_1' } })], 'tool_calls'),
        completion([{ type: 'text', text: '已取消' }], 'stop'),
      ],
      autonomy: 'act',
    });

    const view = await runAgentUntilBlocked(h.deps);

    expect(view.status).toBe('DONE');
    expect(h.exec.calls).toHaveLength(1);
    expect(h.approvalRows()).toHaveLength(0);
  });

  it('resumes an approved step reusing the idempotency key persisted at approval time', async () => {
    const h = await harness({
      script: [
        completion([toolCall('c1', 'order_cancel', { params: { id: 'o_1' } })], 'tool_calls'),
        completion([{ type: 'text', text: '已取消' }], 'stop'),
      ],
    });

    const parked = await runAgentUntilBlocked(h.deps);
    expect(parked.status).toBe('WAITING_APPROVAL');
    const approval = must(h.approvalRows()[0]);
    const storedKey = approval['idempotencyKey'] as string;
    expect(storedKey).toBeTruthy();

    // A human approves; the key must not change.
    Object.assign(approval, { status: 'APPROVED', decidedBy: 'user_admin', decidedAt: new Date() });

    const resumed = await resumeAgent(h.deps, h.deps.runId);

    expect(resumed.status).toBe('DONE');
    expect(h.exec.calls).toHaveLength(1);
    expect(h.exec.calls[0]?.['idempotencyKey']).toBe(storedKey);
    expect(h.approvalRows()[0]?.['idempotencyKey']).toBe(storedKey);
  });

  it('records the denied step as isError with the human reason', async () => {
    const h = await harness({
      script: [
        completion([toolCall('c1', 'order_cancel', { params: { id: 'o_1' } })], 'tool_calls'),
        completion([{ type: 'text', text: '好的，未执行' }], 'stop'),
      ],
    });

    await runAgentUntilBlocked(h.deps);
    const approval = must(h.approvalRows()[0]);
    Object.assign(approval, { status: 'DENIED', decidedBy: 'user_admin', reason: '不允许取消' });

    const resumed = await resumeAgent(h.deps, h.deps.runId);

    expect(h.exec.calls).toHaveLength(0);
    const denied = h
      .stepRows()
      .find((step) => step['kind'] === 'tool_result' && step['isError'] === true);
    expect(denied).toBeDefined();
    expect(JSON.stringify(denied?.['result'])).toContain('不允许取消');
    expect(resumed.status).toBe('DONE');
  });

  it('skips the approval gate for the same capability once granted in this run', async () => {
    const h = await harness({
      script: [
        completion([toolCall('c1', 'order_cancel', { params: { id: 'o_1' } })], 'tool_calls'),
        completion([toolCall('c2', 'order_cancel', { params: { id: 'o_2' } })], 'tool_calls'),
        completion([{ type: 'text', text: '都取消了' }], 'stop'),
      ],
    });

    const parked = await runAgentUntilBlocked(h.deps);
    expect(parked.status).toBe('WAITING_APPROVAL');
    expect(h.approvalRows()).toHaveLength(1);

    // The human approves once; the same capability in this run no longer asks.
    Object.assign(must(h.approvalRows()[0]), {
      status: 'APPROVED',
      decidedBy: 'user_admin',
      decidedAt: new Date(),
    });

    const resumed = await resumeAgent(h.deps, h.deps.runId);

    expect(resumed.status).toBe('DONE');
    expect(h.exec.calls).toHaveLength(2);
    // Still only the one approval row: the second call was covered by the grant.
    expect(h.approvalRows()).toHaveLength(1);
    // Each granted call gets its own fresh key, never the approval row's key.
    const grantedKey = h.exec.calls[1]?.['idempotencyKey'];
    expect(grantedKey).toBeTruthy();
    expect(grantedKey).not.toBe(h.approvalRows()[0]?.['idempotencyKey']);
  });

  it('fails the run once the step budget is exhausted', async () => {
    const h = await harness({
      script: [
        completion([toolCall('c1', 'order_read', { params: { id: 'o_1' } })], 'tool_calls'),
        completion([toolCall('c2', 'order_read', { params: { id: 'o_2' } })], 'tool_calls'),
        completion([toolCall('c3', 'order_read', { params: { id: 'o_3' } })], 'tool_calls'),
      ],
      maxSteps: 1,
    });

    const view = await runAgentUntilBlocked(h.deps);

    expect(view.status).toBe('FAILED');
    expect(view.error).toContain('步数已达上限');
    expect(h.exec.calls.length).toBeLessThanOrEqual(1);
  });

  it('fails the run when the spend cap is reached', async () => {
    // The budget is a *loop* guard: it is re-checked before each new model step,
    // so the run must first spend (one tool step) and only then be stopped.
    const h = await harness({
      script: [
        completion([toolCall('c1', 'order_read', { params: { id: 'o_1' } })], 'tool_calls'),
        completion([{ type: 'text', text: 'hi' }], 'stop'),
      ],
      budgetMinor: 1,
    });

    const view = await runAgentUntilBlocked(h.deps);

    expect(view.status).toBe('FAILED');
    expect(view.error).toContain('预算已用尽');
  });

  it('rejects a model outside the allowlist', async () => {
    const h = await harness({
      script: [completion([{ type: 'text', text: 'never' }], 'stop')],
      model: 'gpt-4o',
      allowedModels: ['gpt-4o-mini'],
    });

    const view = await stepAgent(h.deps);
    expect(view.status).toBe('FAILED');
    expect(view.error).toContain('允许名单');
    expect(h.providerCalls).toHaveLength(0);
  });

  it('turns a provider failure into a visible FAILED run instead of throwing', async () => {
    const h = await harness({ script: [] });
    const failing: LlmProvider = {
      id: 'test',
      name: 'test',
      listModels: async () => [],
      complete: async () => {
        throw new LlmProviderError('upstream_error', 'boom', true);
      },
    };

    const view = await runAgentUntilBlocked({ ...h.deps, provider: failing });

    expect(view.status).toBe('FAILED');
    expect(view.error).toContain('模型调用失败');
  });

  it('hides write tools from a credential without mcp.write', async () => {
    const h = await harness({
      script: [completion([{ type: 'text', text: 'no tools needed' }], 'stop')],
      grantedScopes: new Set<string>(),
    });

    await runAgentUntilBlocked(h.deps);

    const tools = h.providerCalls[0]?.request.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(['order_read']);
  });

  it('audits every step with the real human actor and meta.agent coordinates', async () => {
    auditCalls.length = 0;
    const h = await harness({
      script: [
        completion([toolCall('c1', 'order_read', { params: { id: 'o_1' } })], 'tool_calls'),
        completion([{ type: 'text', text: 'done' }], 'stop'),
      ],
    });

    await runAgentUntilBlocked(h.deps);

    expect(auditCalls.length).toBeGreaterThan(0);
    for (const entry of auditCalls) {
      expect(entry['actorId']).toBe('user_actor');
      const meta = entry['meta'] as { agent: Record<string, unknown> };
      expect(meta.agent['runId']).toBe(h.deps.runId);
      expect(meta.agent['tokenId']).toBe('token_1');
    }
  });

  it('uses a stable per-step callId with no attempt counter', async () => {
    const h = await harness({
      script: [
        completion([toolCall('c1', 'order_read', { params: { id: 'o_1' } })], 'tool_calls'),
        completion([{ type: 'text', text: 'done' }], 'stop'),
      ],
    });

    await runAgentUntilBlocked(h.deps);

    expect(h.providerCalls.map((call) => call.options.callId)).toEqual([
      `${h.deps.runId}:0`,
      `${h.deps.runId}:1`,
    ]);
  });

  it('never bills the caller twice for accumulated cost', async () => {
    const h = await harness({
      script: [
        completion([toolCall('c1', 'order_read', { params: { id: 'o_1' } })], 'tool_calls'),
        completion([{ type: 'text', text: 'done' }], 'stop'),
      ],
    });

    const view = await runAgentUntilBlocked(h.deps);

    // Two completions × costMinor 4 each — accumulated for budgeting only.
    expect(view.spendMinor).toBe(8);
  });

  it('expires a stale approval instead of granting it', async () => {
    const h = await harness({
      script: [
        completion([toolCall('c1', 'order_cancel', { params: { id: 'o_1' } })], 'tool_calls'),
        completion([{ type: 'text', text: '未执行' }], 'stop'),
      ],
    });

    await runAgentUntilBlocked(h.deps);
    const approval = must(h.approvalRows()[0]);
    expect(AGENT_APPROVAL_TTL_MS).toBe(15 * 60 * 1000);
    Object.assign(approval, {
      status: 'PENDING',
      expiresAt: new Date(Date.now() - 1000),
    });

    const resumed = await resumeAgent(h.deps, h.deps.runId);

    expect(h.exec.calls).toHaveLength(0);
    expect(h.approvalRows()[0]?.['status']).toBe('EXPIRED');
    const expiredStep = h
      .stepRows()
      .find((step) => step['kind'] === 'tool_result' && step['isError'] === true);
    expect(JSON.stringify(expiredStep?.['result'])).toContain('审批已超时');
    expect(resumed.status).toBe('DONE');
  });
});

/* ------------------------------------------------------------------ *
 * Approval eligibility (§5.4) — rules ① and ②
 * ------------------------------------------------------------------ */

describe('approval eligibility', () => {
  it('allows the initiator to approve their own scoped run (no four-eyes)', () => {
    const error = approvalEligibility({
      approverId: 'user_actor',
      runActorId: 'user_actor',
      capabilityScope: 'user:write',
      approverSatisfiesScope: true,
    });
    expect(error).toBeNull();
  });

  it('forbids an approver who lacks the capability scope', () => {
    const error = approvalEligibility({
      approverId: 'user_actor',
      runActorId: 'user_actor',
      capabilityScope: 'user:write',
      approverSatisfiesScope: false,
    });
    expect(error?.code).toBe('agent.approval.forbidden');
    expect(error?.status).toBe(403);
  });

  it('allows a different caller who holds the required scope', () => {
    const error = approvalEligibility({
      approverId: 'user_admin',
      runActorId: 'user_actor',
      capabilityScope: 'user:write',
      approverSatisfiesScope: true,
    });
    expect(error).toBeNull();
  });

  it('allows the owner to decide an identity-only (null scope) call', () => {
    const error = approvalEligibility({
      approverId: 'user_actor',
      runActorId: 'user_actor',
      capabilityScope: null,
      approverSatisfiesScope: false,
    });
    expect(error).toBeNull();
  });

  it('forbids a non-owner from deciding an identity-only call', () => {
    const error = approvalEligibility({
      approverId: 'user_admin',
      runActorId: 'user_actor',
      capabilityScope: null,
      approverSatisfiesScope: true,
    });
    expect(error?.code).toBe('agent.approval.not_owner');
    expect(error?.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

describe('agent runtime helpers', () => {
  it('treats an empty allowlist as unrestricted', () => {
    expect(isModelAllowed('anything', [])).toBe(true);
  });

  it('project a run row into the SDK view', async () => {
    const store = fakePrisma();
    const run = await store.prisma.agentRun.create({
      data: {
        actorId: 'user_actor',
        tokenId: 'token_1',
        objective: 'x',
        status: 'QUEUED',
        model: 'm',
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const view = toRunView(run as never);
    expect(view).toMatchObject({
      actorId: 'user_actor',
      tokenId: 'token_1',
      objective: 'x',
      model: 'm',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('agent reliability regressions', () => {
  it('never overwrites cancellation or executes the returned write', async () => {
    const h = await harness({ autonomy: 'act', script: [] });
    h.deps.provider.complete = async () => {
      must(h.runs.get(h.deps.runId)).status = 'CANCELLED';
      return completion([toolCall('c', 'order_cancel', { params: { id: 'o' } })], 'tool_calls');
    };
    expect((await runAgentUntilBlocked(h.deps)).status).toBe('CANCELLED');
    expect(h.exec.calls).toHaveLength(0);
  });
  it('checks the limit before every write in a batch', async () => {
    const h = await harness({
      autonomy: 'act',
      maxSteps: 3,
      script: [
        completion(
          [
            toolCall('a', 'order_cancel', { params: { id: 'a' } }),
            toolCall('b', 'order_cancel', { params: { id: 'b' } }),
          ],
          'tool_calls',
        ),
      ],
    });
    expect((await runAgentUntilBlocked(h.deps)).status).toBe('FAILED');
    expect(h.exec.calls).toHaveLength(1);
    expect(h.stepRows()).toHaveLength(3);
  });
  it('reuses the logical action key after execution interrupted before result storage', async () => {
    const h = await harness({
      autonomy: 'act',
      script: [
        completion([toolCall('c', 'order_cancel', { params: { id: 'a' } })], 'tool_calls'),
        completion([{ type: 'text', text: 'done' }], 'stop'),
      ],
    });
    let first = true;
    h.deps.executor = async (call) => {
      const result = await h.exec.executor(call);
      if (first) {
        first = false;
        throw new Error('interrupted');
      }
      return result;
    };
    await expect(runAgentUntilBlocked(h.deps)).rejects.toThrow('interrupted');
    expect((await resumeAgent(h.deps, h.deps.runId)).status).toBe('DONE');
    expect(h.exec.calls).toHaveLength(2);
    expect(must(h.exec.calls[0]).idempotencyKey).toBe(must(h.exec.calls[1]).idempotencyKey);
  });
  it('does not confuse reused tool IDs across model rounds during crash recovery', async () => {
    const h = await harness({
      autonomy: 'act',
      script: [
        completion([toolCall('same', 'order_cancel', { params: { id: 'first' } })], 'tool_calls'),
        completion([toolCall('same', 'order_cancel', { params: { id: 'second' } })], 'tool_calls'),
        completion([{ type: 'text', text: 'done' }], 'stop'),
      ],
    });
    let interrupted = false;
    h.deps.executor = async (call) => {
      const result = await h.exec.executor(call);
      if (h.exec.calls.length === 2 && !interrupted) {
        interrupted = true;
        throw new Error('lost result');
      }
      return result;
    };
    await expect(runAgentUntilBlocked(h.deps)).rejects.toThrow('lost result');
    expect((await resumeAgent(h.deps, h.deps.runId)).status).toBe('DONE');
    expect(h.exec.calls).toHaveLength(3);
    expect(must(h.exec.calls[0]).idempotencyKey).not.toBe(must(h.exec.calls[1]).idempotencyKey);
    expect(must(h.exec.calls[1]).idempotencyKey).toBe(must(h.exec.calls[2]).idempotencyKey);
  });
  it('honors a live administrative model restriction before inference', async () => {
    const h = await harness({ script: [] });
    h.deps.checkpoint = async () => ({ allowedModels: ['other'] });
    expect((await runAgentUntilBlocked(h.deps)).status).toBe('FAILED');
    expect(h.providerCalls).toHaveLength(0);
  });
  it('retains token accounting when cancellation wins the terminal state race', async () => {
    const h = await harness({ script: [] });
    h.deps.provider.complete = async () => {
      must(h.runs.get(h.deps.runId)).status = 'CANCELLED';
      return completion([{ type: 'text', text: 'done' }], 'stop');
    };
    const run = await runAgentUntilBlocked(h.deps);
    expect(run.status).toBe('CANCELLED');
    expect(run.spendMinor).toBe(4);
    expect(run.tokensIn).toBe(3);
  });
  it('rejects concurrent advancement before a second model call', async () => {
    const h = await harness({ script: [] });
    let complete!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.deps.provider.complete = async () => {
      entered();
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return completion([{ type: 'text', text: 'done' }], 'stop');
    };
    const first = runAgentUntilBlocked(h.deps);
    await started;
    await expect(resumeAgent(h.deps, h.deps.runId)).rejects.toMatchObject({
      code: 'agent.run.busy',
    });
    complete();
    await first;
  });
  it('enforces changed model allowlists on the main entrypoint', async () => {
    const h = await harness({ allowedModels: ['other'], script: [] });
    expect((await runAgentUntilBlocked(h.deps)).status).toBe('FAILED');
    expect(h.providerCalls).toHaveLength(0);
  });
  it('excludes agent management tools so a model cannot approve itself or recurse', async () => {
    const h = await harness({
      capabilities: [{ ...WRITE_CAPABILITY, id: 'agent.run.create' }],
      script: [completion([{ type: 'text', text: 'done' }], 'stop')],
    });
    await runAgentUntilBlocked(h.deps);
    expect(must(h.providerCalls[0]).request.tools ?? []).toHaveLength(0);
  });
  it('aborts a model that ignores AbortSignal without executing its eventual tools', async () => {
    const h = await harness({ autonomy: 'act', script: [] });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.deps.provider.complete = async () => {
      entered();
      return new Promise(() => {});
    };
    const controller = new AbortController();
    h.deps.signal = controller.signal;
    const running = runAgentUntilBlocked(h.deps);
    await started;
    must(h.runs.get(h.deps.runId)).status = 'CANCELLED';
    controller.abort(new Error('cancelled'));
    expect((await running).status).toBe('CANCELLED');
    expect(h.exec.calls).toHaveLength(0);
  });
});

it('invalidates human approval when the installed capability definition changes',async()=>{
  const h=await harness({script:[completion([toolCall('risk','order_cancel',{params:{id:'o_1'}})],'tool_calls')]});
  await runAgentUntilBlocked(h.deps);
  const approval=must(h.approvalRows()[0]);approval['status']='APPROVED';
  h.deps.capabilities=h.deps.capabilities.map((cap)=>cap.id==='order.cancel'?{...cap,path:'/changed/:id'}:cap);
  const result=await resumeAgent(h.deps,h.deps.runId);
  expect(result.status).toBe('FAILED');expect(h.exec.calls).toHaveLength(0);
});
it('refuses an unpriced write when a monetary budget is active',async()=>{
  const h=await harness({autonomy:'act',budgetMinor:100,script:[completion([toolCall('risk','order_cancel',{params:{id:'o_1'}})],'tool_calls')]});
  const result=await runAgentUntilBlocked(h.deps);
  expect(result.status).toBe('FAILED');expect(h.exec.calls).toHaveLength(0);
});
