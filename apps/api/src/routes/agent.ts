/**
 * Kernel Agent HTTP surface (PLAN-agent-in-kernel §3.4 / §4 / §5).
 *
 * All seven endpoints live under `/api/v1` so they are ordinary platform
 * capabilities: an external MCP client reaches them exactly the way the kernel
 * loop reaches every other tool. The loop itself is a deep module
 * (`../lib/agent-runtime.ts`); this file only wires it — it authenticates the
 * caller with the existing guards, resolves the model provider, derives the
 * caller-scoped capability list, and supplies the executor.
 *
 * The executor **re-enters this application's own HTTP stack** via
 * `request.server.inject()`, copying the caller's `authorization`/`cookie`
 * headers. That is the same ten lines `apps/api/src/mcp/routes.ts:23`
 * (`executeViaApi`) performs for external MCP clients; it is duplicated here
 * because that helper is module-private and `apps/api/src/mcp/**` is frozen for
 * this task (reuse would require editing the frozen module). The duplicate is
 * intentional and must stay in lockstep: it is exactly what makes the in-turn
 * call run the real `requireAuth` / `requirePermission` / quota / idempotency
 * guards, so the kernel Agent holds no privilege an ordinary API caller does not.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PluginError } from '@stackpanel/sdk';
import type { AgentAutonomy, McpApiCall, McpCapability } from '@stackpanel/sdk';
import type { AgentApproval, AgentRun, PrismaClient } from '@stackpanel/db';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { currentUser, requireAuth } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { CAPABILITIES, scopeSatisfied } from '../lib/capability-registry.ts';
import { readConfiguredLlmConfig, resolveLlmProvider } from '../lib/llm-provider.ts';
import { resumeAgent, runAgentUntilBlocked, toRunView } from '../lib/agent-runtime.ts';
import type { AgentRuntimeDeps, AgentToolExecution } from '../lib/agent-runtime.ts';
import { mcpCapabilitiesFor, mcpGrantedScopes } from '../mcp/index.ts';

/**
 * Site master switch (PLAN §1: 只有管理员能决定「本站是否提供 AI」，默认关).
 * The plan names no Setting key; `agent.enabled` follows the dotted convention of
 * `agent.llm` / `platform.info`. Read leniently so either `true` or
 * `{ enabled: true }` turns it on.
 */
export const AGENT_ENABLED_SETTING_KEY = 'agent.enabled';

/** Caps used when the credential has no `AgentProfile` row yet. */
const DEFAULT_MAX_STEPS = 50;
const DEFAULT_BUDGET_MINOR = 0;

const createRunSchema = z
  .object({
    objective: z.string().trim().min(1).max(4000),
    model: z.string().trim().min(1).max(191).optional(),
    autonomy: z.enum(['read', 'propose', 'act']).optional(),
    maxSteps: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().min(1).max(191).optional(),
});

const idParamSchema = z.object({ id: z.string().min(1).max(191) });

const decideSchema = z
  .object({
    approve: z.boolean(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

type RunCaps = {
  autonomy: AgentAutonomy;
  maxSteps: number;
  budgetMinor: number;
  maxRunSeconds: number | null;
  allowedModels: string[];
};

function validationError(): PluginError {
  return new PluginError('validation.invalid', 422, '请求参数无效');
}

function disabled(): PluginError {
  return new PluginError('agent.disabled', 403, '本站尚未开放 AI 能力（管理员可在后台开启）');
}

function llmUnconfigured(): PluginError {
  return new PluginError(
    'agent.llm_unconfigured',
    503,
    '尚未配置模型：请在后台设置中填写接口地址、密钥与模型名',
  );
}

function runNotFound(): PluginError {
  return new PluginError('agent.run_not_found', 404, '运行不存在');
}

function approvalNotFound(): PluginError {
  return new PluginError('agent.approval_not_found', 404, '审批不存在或已处理');
}

/** Read the site master switch; a missing row or malformed value means off. */
async function isAgentEnabled(prisma: PrismaClient): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: AGENT_ENABLED_SETTING_KEY } });
  const value: unknown = row?.value;
  if (value === true) return true;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return (value as Record<string, unknown>)['enabled'] === true;
  }
  return false;
}

/**
 * Execute one resolved tool call through the app's own inject() stack — the
 * kernel-side twin of `apps/api/src/mcp/routes.ts:23`. The caller's credential is
 * forwarded verbatim, so the in-turn request is authorized as the caller.
 */
function makeExecutor(request: FastifyRequest): (call: McpApiCall) => Promise<AgentToolExecution> {
  return async (call) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    const authorization = request.headers.authorization;
    const cookie = request.headers.cookie;
    if (typeof authorization === 'string') headers['authorization'] = authorization;
    if (typeof cookie === 'string') headers['cookie'] = cookie;
    if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey;

    const response = await request.server.inject({
      method: call.method,
      url: call.path,
      headers,
      ...(call.body !== undefined ? { payload: call.body as Record<string, unknown> } : {}),
    });
    return {
      statusCode: response.statusCode,
      contentType: String(response.headers['content-type'] ?? ''),
      body: response.body,
    };
  };
}

/** Kernel + active-plugin capabilities: the same universe MCP exposes. */
function allCapabilities(request: FastifyRequest): readonly McpCapability[] {
  return [...CAPABILITIES, ...request.server.pluginRuntime.listCapabilities()];
}

function findCapability(request: FastifyRequest, capabilityId: string): McpCapability | null {
  return allCapabilities(request).find((capability) => capability.id === capabilityId) ?? null;
}

/**
 * Whether the **current caller** holds the permission a capability requires
 * (PLAN §5.4: the approver must hold the permission the approved capability
 * needs). A token caller must carry the scope effectively; a session caller is
 * judged by their live permission set, exactly like `requireOpenScope`
 * (apps/api/src/plugins/auth.ts:337).
 *
 * A `null` scope is identity-only, so any authenticated caller satisfies it —
 * rule ① (approver ≠ run actor) is what constrains that case.
 */
function callerSatisfiesScope(request: FastifyRequest, scope: string | null): boolean {
  if (scope === null) return true;
  const user = currentUser(request);
  if (user.viaApiToken) return (user.effectiveScopes ?? []).includes(scope);
  return scopeSatisfied(scope, user.permissions, request.server.pluginRuntime.scopeGovernance());
}

/** Profile-derived caps for a token, then request-body overrides. */
async function resolveCaps(
  prisma: PrismaClient,
  tokenId: string,
  body: { autonomy?: AgentAutonomy | undefined; maxSteps?: number | undefined },
): Promise<RunCaps> {
  const profile = await prisma.agentProfile.findFirst({ where: { apiTokenId: tokenId } });
  const raw: unknown = profile?.allowedModels;
  const allowedModels = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    autonomy: body.autonomy ?? profile?.autonomy ?? 'read',
    maxSteps: body.maxSteps ?? profile?.maxSteps ?? DEFAULT_MAX_STEPS,
    budgetMinor: profile?.budgetMinor ?? DEFAULT_BUDGET_MINOR,
    maxRunSeconds: profile?.maxRunSeconds ?? null,
    allowedModels,
  };
}

/** Assemble the loop's dependencies; the provider is resolved per request. */
async function buildDeps(
  request: FastifyRequest,
  run: AgentRun,
  caps: RunCaps,
): Promise<AgentRuntimeDeps> {
  const provider = await resolveLlmProvider(request.server.pluginRuntime);
  if (!provider) throw llmUnconfigured();
  return {
    prisma: getPrisma(),
    provider,
    // The caller's own view of the capabilities: a tool the caller cannot reach
    // is not merely refused at execution time, it is absent from the model's tool
    // list entirely (same 口径 as apps/api/src/mcp/registry.ts:45).
    capabilities: mcpCapabilitiesFor(request),
    executor: makeExecutor(request),
    actorId: run.actorId,
    tokenId: run.tokenId,
    runId: run.id,
    objective: run.objective,
    model: run.model ?? '',
    autonomy: caps.autonomy,
    maxSteps: caps.maxSteps,
    budgetMinor: caps.budgetMinor,
    allowedModels: caps.allowedModels,
    grantedScopes: mcpGrantedScopes(request),
    maxRunSeconds: caps.maxRunSeconds,
  };
}

/** `AgentRun.tokenId` is required, so a session caller cannot start a run (§3.4). */
function requireTokenCaller(request: FastifyRequest): { actorId: string; tokenId: string } {
  const user = currentUser(request);
  if (user.viaApiToken !== true || !user.tokenId) {
    throw new PluginError(
      'agent.token_required',
      400,
      '内核 Agent 需要一把平台凭证（API Key）来行事：请用 API Key 调用本接口',
    );
  }
  return { actorId: user.id, tokenId: user.tokenId };
}

/** Choose the model: explicit body → allowlist → the admin's configured model. */
async function resolveModel(
  prisma: PrismaClient,
  requested: string | undefined,
  caps: RunCaps,
): Promise<string | null> {
  if (requested) return requested;
  const first = caps.allowedModels[0];
  if (first) return first;
  const configured = await readConfiguredLlmConfig(prisma);
  return configured?.model ?? null;
}

function toApprovalView(approval: AgentApproval): Record<string, unknown> {
  return {
    id: approval.id,
    runId: approval.runId,
    stepId: approval.stepId,
    capabilityId: approval.capabilityId,
    args: approval.args,
    idempotencyKey: approval.idempotencyKey,
    status: approval.status,
    decidedBy: approval.decidedBy,
    decidedAt: approval.decidedAt ? approval.decidedAt.toISOString() : null,
    expiresAt: approval.expiresAt ? approval.expiresAt.toISOString() : null,
    reason: approval.reason,
    createdAt: approval.createdAt.toISOString(),
  };
}

/**
 * The two rules that make the approval gate meaningful (PLAN §5.4). Exported
 * separately from the handler so it is unit-testable without HTTP or a DB.
 *
 * ① 审批人不得是该 run 的 actorId —— 不许自批自。
 * ② 审批人当前必须具备被审批能力所需的权限。
 *
 * The plan explicitly rejects both Microsoft-style identity-layer blocking and a
 * four-eyes layer, so these two rules are the *whole* policy: no extra
 * restrictions are added, and neither is relaxed. A capability with `scope: null`
 * is identity-only, which means any authenticated caller satisfies ② — rule ① is
 * what constrains that case.
 */
export function approvalEligibility(input: {
  approverId: string;
  runActorId: string;
  capabilityScope: string | null;
  approverSatisfiesScope: boolean;
}): PluginError | null {
  if (input.capabilityScope !== null) {
    // Scoped capability: the deciding caller must hold the permission the tool
    // needs. A normal user cannot hold an admin capability, so "the owner clicks
    // approve on their own run" is safe by construction (提出者口径: 普通用户没有管理员
    // 能力，自己批自己即可). This deliberately replaces the old four-eyes rule ①.
    if (!input.approverSatisfiesScope) {
      return new PluginError('agent.approval.forbidden', 403, '你不具备该操作所需的权限，无法审批');
    }
    return null;
  }
  // `scope: null` means identity-only: the action is only ever meaningful as the
  // run's own owner, so *only* the owner may decide. Without this, any
  // authenticated caller could approve anyone's identity-only tool call.
  if (input.approverId !== input.runActorId) {
    return new PluginError(
      'agent.approval.not_owner',
      403,
      '该操作只有发起人本人可以确认，他人无法代为批准',
    );
  }
  return null;
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  /** Auth first (401 for anonymous), then the site master switch (§1). */
  const guard = [
    requireAuth,
    async (): Promise<void> => {
      if (!(await isAgentEnabled(prisma))) throw disabled();
    },
  ];

  app.post('/api/v1/agent/runs', { preHandler: guard }, async (request, reply) => {
    const body = createRunSchema.safeParse(request.body);
    if (!body.success) throw validationError();
    const { actorId, tokenId } = requireTokenCaller(request);

    const caps = await resolveCaps(prisma, tokenId, body.data);
    const model = await resolveModel(prisma, body.data.model, caps);
    if (!model) throw llmUnconfigured();
    // Allowlist is checked *before* the run exists, so a rejected model never
    // leaves a row behind (the runtime throw is only a defensive backstop).
    if (caps.allowedModels.length > 0 && !caps.allowedModels.includes(model)) {
      throw new PluginError(
        'agent.model_not_allowed',
        403,
        `模型 ${model} 不在该凭证的模型白名单内`,
      );
    }

    const run = await prisma.agentRun.create({
      data: {
        actorId,
        tokenId,
        objective: body.data.objective,
        status: 'QUEUED',
        model,
        startedAt: new Date(),
      },
    });
    await writeAudit({
      action: 'agent.run.create',
      resource: 'agent.run',
      resourceId: run.id,
      meta: {
        agent: { runId: run.id, tokenId, model, autonomy: caps.autonomy, step: 0 },
      },
      ...auditContext(request),
    });

    const deps = await buildDeps(request, run, caps);
    const view = await runAgentUntilBlocked(deps);
    return reply.code(201).send({ run: view });
  });

  app.get('/api/v1/agent/runs', { preHandler: guard }, async (request) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) throw validationError();
    const user = currentUser(request);
    const limit = query.data.limit ?? 20;
    const rows = await prisma.agentRun.findMany({
      where: { actorId: user.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.data.cursor ? { cursor: { id: query.data.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      runs: page.map(toRunView),
      nextCursor: rows.length > limit && last ? last.id : null,
    };
  });

  app.get('/api/v1/agent/runs/:id', { preHandler: guard }, async (request) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) throw validationError();
    const user = currentUser(request);
    const run = await prisma.agentRun.findFirst({
      where: { id: params.data.id, actorId: user.id },
    });
    if (!run) throw runNotFound();
    const steps = await prisma.agentStep.findMany({
      where: { runId: run.id },
      orderBy: { index: 'asc' },
    });
    return { run: toRunView(run), steps: steps.map((step) => ({ ...step, createdAt: step.createdAt.toISOString() })) };
  });

  app.post('/api/v1/agent/runs/:id/resume', { preHandler: guard }, async (request) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) throw validationError();
    const user = currentUser(request);
    const run = await prisma.agentRun.findFirst({
      where: { id: params.data.id, actorId: user.id },
    });
    if (!run) throw runNotFound();
    if (run.status !== 'WAITING_APPROVAL' && run.status !== 'RUNNING') {
      throw new PluginError('agent.run.not_resumable', 409, '该运行当前不可继续推进');
    }
    const caps = await resolveCaps(prisma, run.tokenId, {});
    const deps = await buildDeps(request, run, caps);
    const view = await resumeAgent(deps, run.id);
    await writeAudit({
      action: 'agent.run.resume',
      resource: 'agent.run',
      resourceId: run.id,
      meta: {
        agent: { runId: run.id, tokenId: run.tokenId, model: view.model, step: view.steps },
      },
      ...auditContext(request),
    });
    return { run: view };
  });

  app.post('/api/v1/agent/runs/:id/cancel', { preHandler: guard }, async (request) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) throw validationError();
    const user = currentUser(request);
    const run = await prisma.agentRun.findFirst({
      where: { id: params.data.id, actorId: user.id },
    });
    if (!run) throw runNotFound();
    if (run.status === 'DONE' || run.status === 'FAILED' || run.status === 'CANCELLED') {
      throw new PluginError('agent.run.not_cancellable', 409, '该运行已结束，无法取消');
    }
    const updated = await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: 'CANCELLED', endedAt: new Date() },
    });
    await writeAudit({
      action: 'agent.run.cancel',
      resource: 'agent.run',
      resourceId: run.id,
      meta: { agent: { runId: run.id, tokenId: run.tokenId, model: run.model, step: run.steps } },
      ...auditContext(request),
    });
    return { run: toRunView(updated) };
  });

  app.get('/api/v1/agent/approvals', { preHandler: guard }, async (request) => {
    const user = currentUser(request);
    const rows = await prisma.agentApproval.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { run: true },
    });
    // Visibility mirrors `approvalEligibility` exactly, so the queue never shows
    // a decision the caller would be refused on.
    const visible = rows.filter((row) => {
      const capability = findCapability(request, row.capabilityId);
      if (!capability) return false;
      return (
        approvalEligibility({
          approverId: user.id,
          runActorId: row.run.actorId,
          capabilityScope: capability.scope,
          approverSatisfiesScope: callerSatisfiesScope(request, capability.scope),
        }) === null
      );
    });
    return {
      approvals: visible.map((row) => ({
        ...toApprovalView(row),
        run: { id: row.run.id, actorId: row.run.actorId, objective: row.run.objective },
      })),
    };
  });

  app.post('/api/v1/agent/approvals/:id/decide', { preHandler: guard }, async (request) => {
    const params = idParamSchema.safeParse(request.params);
    const body = decideSchema.safeParse(request.body);
    if (!params.success || !body.success) throw validationError();

    const user = currentUser(request);
    const approval = await prisma.agentApproval.findUnique({
      where: { id: params.data.id },
      include: { run: true },
    });
    if (!approval || approval.status !== 'PENDING') throw approvalNotFound();

    const capability = findCapability(request, approval.capabilityId);
    if (!capability) {
      throw new PluginError('agent.approval.capability_unavailable', 409, '该能力项已不可用');
    }
    // The deciding caller must hold the permission the capability needs; for
    // identity-only capabilities (scope === null) only the run's owner may decide.
    // No four-eyes layer beyond this is added (PLAN §5.4).
    const denied = approvalEligibility({
      approverId: user.id,
      runActorId: approval.run.actorId,
      capabilityScope: capability.scope,
      approverSatisfiesScope: callerSatisfiesScope(request, capability.scope),
    });
    if (denied) throw denied;
    if (approval.expiresAt && approval.expiresAt.getTime() <= Date.now()) {
      await prisma.agentApproval.update({
        where: { id: approval.id },
        data: { status: 'EXPIRED', decidedAt: new Date(), reason: '审批超时' },
      });
      throw new PluginError('agent.approval.expired', 409, '审批已超时');
    }

    const updated = await prisma.agentApproval.update({
      where: { id: approval.id },
      data: {
        status: body.data.approve ? 'APPROVED' : 'DENIED',
        decidedBy: user.id,
        decidedAt: new Date(),
        ...(body.data.reason !== undefined ? { reason: body.data.reason } : {}),
      },
    });
    await writeAudit({
      action: body.data.approve ? 'agent.approval.approve' : 'agent.approval.deny',
      resource: 'agent.approval',
      resourceId: updated.id,
      meta: {
        agent: {
          runId: approval.runId,
          tokenId: approval.run.tokenId,
          model: approval.run.model,
          capabilityId: approval.capabilityId,
        },
        ...(body.data.reason !== undefined ? { reason: body.data.reason } : {}),
      },
      ...auditContext(request),
    });

    if (!body.data.approve) {
      return { approval: toApprovalView(updated), run: toRunView(approval.run) };
    }

    // Execution must always happen on the *initiator's* credential: the key that
    // started the run stays the ceiling, so revoking it also stops the agent
    // (§3.4, 提出者口径「发起人前往官网审批授权一次…跨对话需要重新审批」). When the
    // deciding caller IS the actor, this request already carries that credential,
    // so advancing here is both safe and saves a round trip. When the approver is
    // somebody else, we record the decision only and leave the advance to the
    // initiator's `/resume` — never run the write on the approver's key.
    if (user.id !== approval.run.actorId) {
      return { approval: toApprovalView(updated), run: toRunView(approval.run) };
    }
    const caps = await resolveCaps(prisma, approval.run.tokenId, {});
    try {
      const deps = await buildDeps(request, approval.run, caps);
      const view = await resumeAgent(deps, approval.runId);
      return { approval: toApprovalView(updated), run: view };
    } catch (error) {
      // The decision is already durable; a missing/unreachable provider must not
      // lose it. Surface the decision and let the caller retry via /resume.
      if (error instanceof PluginError) {
        return { approval: toApprovalView(updated), run: toRunView(approval.run) };
      }
      throw error;
    }
  });
}
