import { parseAgent } from '../agent/validation.ts';
import { actionRoutes, actionCapabilities } from '../agent/actions.ts';
import { agentOAuthRoutes } from '../agent/oauth.ts';
import { isSecretsEnabled } from '../lib/crypto.ts';
import { authorizeBackground, revokeBackground, registerAgentJobs } from '../agent/background.ts';
import { externalAgentRoutes } from '../agent/external-routes.ts';
import { externalCapabilities } from '../agent/external.ts';
import { journaledProvider } from '../agent/metering.ts';
/** Kernel Agent routes. Tool calls re-enter HTTP guards using the original API Key. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { PluginError } from '@stackpanel/sdk';
import type { AgentAutonomy, McpApiCall, McpCapability } from '@stackpanel/sdk';
import type { AgentApproval, AgentRun, PrismaClient } from '@stackpanel/db';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { currentUser, requireAuth, requireRole, extractSession } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { CAPABILITIES, scopeSatisfied } from '../lib/capability-registry.ts';
import { readConfiguredLlmConfig, resolveLlmProvider } from '../lib/llm-provider.ts';
import { resumeAgent, runAgentUntilBlocked, toRunView } from '../lib/agent-runtime.ts';
import type { AgentRuntimeDeps, AgentToolExecution } from '../lib/agent-runtime.ts';
import { mcpCapabilitiesFor, mcpGrantedScopes } from '../mcp/index.ts';
import {
  agentPolicySchema,
  policyFromProfile,
  restrictAgentPolicy,
  agentDayStart,
} from '../lib/agent-policy.ts';
import type { AgentPolicy } from '../lib/agent-policy.ts';
import { enforceTokenQuota } from '../lib/open-api-guard.ts';
import { notifyAgent } from '../notifications/agent-notifications.ts';

/**
 * Site master switch (PLAN §1: 只有管理员能决定「本站是否提供 AI」，默认关).
 * The plan names no Setting key; `agent.enabled` follows the dotted convention of
 * `agent.llm` / `platform.info`. Read leniently so either `true` or
 * `{ enabled: true }` turns it on.
 */
export const AGENT_ENABLED_SETTING_KEY = 'agent.enabled';

const createRunSchema = z
  .object({
    parentId: z.string().min(1).max(191).optional(),
    execution: z.enum(['request', 'background']).optional(),
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

type RunCaps = AgentPolicy;

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
    if (typeof authorization === 'string') headers['authorization'] = authorization;
    // Execution always carries the original API token, never a session cookie.
    if (call.idempotencyKey) headers['idempotency-key'] = call.idempotencyKey;

    const response = await request.server.inject({
      method: call.method,
      url: call.path,
      remoteAddress: request.ip,
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
async function allCapabilities(request: FastifyRequest): Promise<readonly McpCapability[]> {
  return [...CAPABILITIES, ...request.server.pluginRuntime.listCapabilities(), ...await externalCapabilities(request), ...await actionCapabilities(request)];
}

async function findCapability(request: FastifyRequest, capabilityId: string): Promise<McpCapability | null> {
  return (await allCapabilities(request)).find((capability) => capability.id === capabilityId) ?? null;
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
  const profile = await prisma.agentProfile.findUnique({ where: { apiTokenId: tokenId } });
  return restrictAgentPolicy(policyFromProfile(profile), {
    ...(body.autonomy !== undefined ? { autonomy: body.autonomy } : {}),
    ...(body.maxSteps !== undefined ? { maxSteps: body.maxSteps } : {}),
  });
}

/** Assemble the loop's dependencies; the provider is resolved per request. */
async function buildDeps(
  request: FastifyRequest,
  run: AgentRun,
  caps: RunCaps,
): Promise<AgentRuntimeDeps> {
  const provider = await resolveLlmProvider(request.server.pluginRuntime);
  if (!provider) throw llmUnconfigured();
  if (provider.id === 'configured' && (caps.budgetMinor || caps.dailyBudgetMinor)) {
    throw new PluginError(
      'agent.pricing_unknown',
      409,
      '兜底模型费用未知，无法执行金额预算；请配置可计价的模型提供方或使用步数额度',
    );
  }
  const validateCredential = async (): Promise<void> => {
    const fresh = await extractSession(request);
    if (
      !fresh ||
      fresh.impersonatorId ||
      fresh.tokenId !== run.tokenId ||
      fresh.id !== run.actorId
    ) {
      throw new PluginError('agent.credential_invalid', 403, '原 API Key 已失效，任务不能继续');
    }
    if (!(await isAgentEnabled(getPrisma()))) throw disabled();
    request.user = fresh;
  };
  const checkpoint = async (
    _kind: 'model' | 'tool',
    reserve: number,
  ): Promise<Partial<AgentRuntimeDeps>> => {
    await validateCredential();
    const current = await resolveCaps(getPrisma(), run.tokenId, {});
    Object.assign(caps, restrictAgentPolicy(current, caps));
    let ancestor = run.parentId ? await getPrisma().agentRun.findUnique({where:{id:run.parentId}}) : null;
    for(let depth=0;ancestor && depth<4;depth++){
      if (['FAILED','CANCELLED'].includes(ancestor.status)) throw new PluginError('agent.parent_stopped',409,'上级任务已停止');
      if (ancestor.policy) Object.assign(caps,restrictAgentPolicy(caps,agentPolicySchema.parse(ancestor.policy)));
      ancestor = ancestor.parentId ? await getPrisma().agentRun.findUnique({where:{id:ancestor.parentId}}) : null;
    }
    const root = run.rootId ? await getPrisma().agentRun.findUnique({ where: { id: run.rootId } }) : run;
    if (!root || ['FAILED', 'CANCELLED'].includes(root.status)) throw new PluginError('agent.parent_stopped', 409, '主任务已停止');
    const family = await getPrisma().agentRun.findMany({ where: { OR: [{ id: root.id }, { rootId: root.id }] }, select: { id: true } });
    const familySteps = await getPrisma().agentStep.count({ where: { runId: { in: family.map((row) => row.id) } } });
    if (familySteps + reserve > caps.maxSteps || (root.startedAt && Date.now() - root.startedAt.getTime() > caps.maxRunSeconds * 1000)) throw new PluginError('agent.family_limit', 429, '任务组的总步数或时间预算已耗尽');
    const totals = await getPrisma().agentStep.aggregate({
      where: { run: { actorId: run.actorId }, createdAt: { gte: agentDayStart() } },
      _count: { _all: true },
      _sum: { costMinor: true },
    });
    if (
      totals._count._all + reserve > caps.dailySteps ||
      (caps.dailyBudgetMinor && (totals._sum.costMinor ?? 0) >= caps.dailyBudgetMinor)
    ) {
      throw new PluginError('agent.daily_limit', 429, '今日 Agent 额度已用尽');
    }
    return {
      autonomy: caps.autonomy,
      maxSteps: caps.maxSteps,
      maxRunSeconds: caps.maxRunSeconds,
      budgetMinor: caps.budgetMinor ?? 0,
      allowedModels: caps.allowedModels,
    };
  };
  return {
    prisma: getPrisma(),
    provider: journaledProvider(provider, run.id, run.actorId, caps),
    // The caller's own view of the capabilities: a tool the caller cannot reach
    // is not merely refused at execution time, it is absent from the model's tool
    // list entirely (same 口径 as apps/api/src/mcp/registry.ts:45).
    capabilities: [...mcpCapabilitiesFor(request), ...await externalCapabilities(request), ...await actionCapabilities(request)].filter(
      (capability) => !capability.id.startsWith('agent.'),
    ),
    executor: makeExecutor(request),
    actorId: run.actorId,
    tokenId: run.tokenId,
    runId: run.id,
    objective: run.objective,
    model: run.model ?? '',
    autonomy: caps.autonomy,
    maxSteps: caps.maxSteps,
    budgetMinor: caps.budgetMinor ?? 0,
    allowedModels: caps.allowedModels,
    grantedScopes: mcpGrantedScopes(request),
    maxRunSeconds: caps.maxRunSeconds,
    checkpoint,
    validateCredential,
    notifyApproval: async (approvalId) => {
      const approval = await getPrisma().agentApproval.findUnique({ where: { id: approvalId } });
      if (!approval) return;
      for (const userId of new Set([
        run.actorId,
        ...(caps.approvalNotify ? [caps.approvalNotify] : []),
      ])) {
        await notifyAgent(request.server.notifications, userId, run.id, {
          key: `approval:${approvalId}`,
          type: 'agent.approval.pending',
          title: 'Agent 操作等待确认',
          body: `Agent 请求执行 ${approval.capabilityId}，请在审批队列查看有权处理的操作。`,
          link: '/account/agent/approvals',
          data: { approvalId, capabilityId: approval.capabilityId },
        });
      }
    },
  };
}

/** `AgentRun.tokenId` is required, so a session caller cannot start a run (§3.4). */
function requireTokenCaller(request: FastifyRequest): { actorId: string; tokenId: string } {
  const user = currentUser(request);
  if (user.impersonatorId || user.viaApiToken !== true || !user.tokenId) {
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

/** The owner may confirm their own intent; scoped actions also require the tool's permission. */
export function approvalEligibility(input: {
  approverId: string;
  runActorId: string;
  capabilityScope: string | null;
  approverSatisfiesScope: boolean;
  destructive?: boolean;
}): PluginError | null {
  if (input.destructive && input.approverId !== input.runActorId) return new PluginError('agent.approval.not_owner', 403, '高风险操作必须由发起人本人确认');
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

/** Reject session/sibling-key continuation even when the human owner is the same. */
export function requireOriginalAgentToken(
  request: FastifyRequest,
  run: Pick<AgentRun, 'actorId' | 'tokenId'>,
): void {
  const caller = requireTokenCaller(request);
  if (caller.actorId !== run.actorId || caller.tokenId !== run.tokenId) {
    throw new PluginError(
      'agent.original_token_required',
      403,
      '请使用创建该任务的原 API Key 继续执行',
    );
  }
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  await app.register(actionRoutes);
  await app.register(externalAgentRoutes);
  await app.register(agentOAuthRoutes);
  registerAgentJobs(app);
  const prisma = getPrisma();
  const authenticated = [requireAuth, enforceTokenQuota];
  const guard = [
    ...authenticated,
    async (): Promise<void> => {
      if (!(await isAgentEnabled(prisma))) throw disabled();
    },
  ];
  const ownedRun = async (request: FastifyRequest): Promise<AgentRun> => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) throw validationError();
    const run = await prisma.agentRun.findFirst({
      where: { id: params.data.id, actorId: currentUser(request).id },
    });
    if (!run) throw runNotFound();
    return run;
  };
  const drive = async (request: FastifyRequest, run: AgentRun, first = false) => {
    requireOriginalAgentToken(request, run);
    const current = await resolveCaps(prisma, run.tokenId, {});
    const saved = run.policy ? agentPolicySchema.parse(run.policy) : policyFromProfile(null);
    const caps = restrictAgentPolicy(current, saved);
    const deps = await buildDeps(request, run, caps);
    const view = first ? await runAgentUntilBlocked(deps) : await resumeAgent(deps, run.id);
    if (['DONE', 'FAILED', 'CANCELLED'].includes(view.status)) {
      await notifyAgent(app.notifications, run.actorId, run.id, {
        key: `terminal:${view.status}`,
        type: `agent.run.${view.status.toLowerCase()}`,
        title:
          view.status === 'DONE'
            ? 'Agent 任务已完成'
            : view.status === 'FAILED'
              ? 'Agent 任务失败'
              : 'Agent 任务已取消',
        body: view.error ?? run.objective.slice(0, 200),
        status: view.status === 'FAILED' ? 'error' : 'success',
      });
    }
    return view;
  };

  app.get('/api/v1/agent/credential', { preHandler: authenticated }, async (request) => {
    const { actorId, tokenId } = requireTokenCaller(request);
    return { actorId, tokenId };
  });

  // Read access and configuration remain available while the execution switch is off.
  app.get('/admin/agent/runs', { preHandler: [requireAuth, requireRole('ADMIN')] }, async (request) => {
    const query = listQuerySchema.safeParse(request.query); if (!query.success) throw validationError();
    const limit = query.data.limit ?? 20;
    const runs = await prisma.agentRun.findMany({ orderBy: [{createdAt:'desc'},{id:'desc'}], take:limit + 1, ...(query.data.cursor ? {cursor:{id:query.data.cursor},skip:1} : {}) });
    return { runs: runs.slice(0,limit).map((run) => ({...toRunView(run),actorId:run.actorId,tokenId:run.tokenId})), nextCursor:runs.length > limit ? runs[limit - 1]?.id : null };
  });
  app.put('/admin/agent/enabled', { preHandler:[requireAuth,requireRole('ADMIN')] }, async (request) => {
    if (currentUser(request).impersonatorId) throw new PluginError('agent.impersonation_forbidden', 403, '冒用会话不能管理 Agent');
    const parsed = z.object({enabled:z.boolean()}).strict().safeParse(request.body); if (!parsed.success) throw validationError();
    await prisma.setting.upsert({where:{key:AGENT_ENABLED_SETTING_KEY},create:{key:AGENT_ENABLED_SETTING_KEY,value:parsed.data},update:{value:parsed.data}});
    await writeAudit({action:'agent.enabled.update',resource:'setting',resourceId:AGENT_ENABLED_SETTING_KEY,...auditContext(request)});
    return parsed.data;
  });
  app.get('/api/v1/agent/status', { preHandler: authenticated }, async () => {
    const provider = await resolveLlmProvider(app.pluginRuntime);
    return {
      enabled: await isAgentEnabled(prisma),
      modelConfigured: provider !== null,
      provider: provider ? { id: provider.id, name: provider.name } : null,
    };
  });
  app.get('/api/v1/agent/models', { preHandler: authenticated }, async (request) => {
    const provider = await resolveLlmProvider(app.pluginRuntime);
    if (!provider) return { models: [] };
    const user = currentUser(request);
    const caps = user.tokenId
      ? await resolveCaps(prisma, user.tokenId, {})
      : policyFromProfile(null);
    return {
      models: (await provider.listModels()).filter(
        (model) =>
          model.supportsTools &&
          (!caps.allowedModels.length || caps.allowedModels.includes(model.id)),
      ),
    };
  });
  const profileToken = async (request: FastifyRequest, admin = false) => {
    const params = z.object({ tokenId: z.string().min(1).max(191) }).safeParse(request.params);
    if (!params.success) throw validationError();
    const token = await prisma.apiToken.findFirst({
      where: { id: params.data.tokenId, ...(!admin ? { userId: currentUser(request).id } : {}) },
    });
    if (!token) throw new PluginError('agent.token_not_found', 404, 'API Key 不存在');
    return token;
  };
  app.get('/api/v1/agent/profiles/:tokenId', { preHandler: authenticated }, async (request) => {
    const token = await profileToken(request);
    const profile = await prisma.agentProfile.findUnique({ where: { apiTokenId: token.id } });
    return { tokenId: token.id, policy: policyFromProfile(profile), configured: profile !== null };
  });
  app.get(
    '/admin/agent/profiles/:tokenId',
    { preHandler: [requireAuth, requireRole('ADMIN')] },
    async (request) => {
      const token = await profileToken(request, true);
      const profile = await prisma.agentProfile.findUnique({ where: { apiTokenId: token.id } });
      return {
        tokenId: token.id,
        policy: policyFromProfile(profile),
        configured: profile !== null,
      };
    },
  );
  app.put(
    '/admin/agent/profiles/:tokenId',
    { preHandler: [requireAuth, requireRole('ADMIN')] },
    async (request) => {
      if (currentUser(request).impersonatorId)
        throw new PluginError('agent.impersonation_forbidden', 403, '冒用会话不能管理 Agent 策略');
      const token = await profileToken(request, true);
      const parsed = agentPolicySchema.safeParse(request.body);
      if (!parsed.success) throw validationError();
      const policy = parsed.data;
      if (
        policy.approvalNotify &&
        !(await prisma.user.findUnique({ where: { id: policy.approvalNotify } }))
      )
        throw validationError();
      const profile = await prisma.agentProfile.upsert({
        where: { apiTokenId: token.id },
        create: { apiTokenId: token.id, ...policy },
        update: policy,
      });
      await writeAudit({
        action: 'agent.profile.update',
        resource: 'api-token',
        resourceId: token.id,
        ...auditContext(request),
      });
      return { tokenId: token.id, policy: policyFromProfile(profile), configured: true };
    },
  );

  app.post('/api/v1/agent/runs', { preHandler: guard }, async (request, reply) => {
    const parsed = createRunSchema.safeParse(request.body);
    if (!parsed.success) throw validationError();
    const { actorId, tokenId } = requireTokenCaller(request);
    if (parsed.data.execution === 'background' && !isSecretsEnabled()) throw new PluginError('secret.storage.disabled', 501, '后台执行需要加密密钥存储');
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
      throw new PluginError(
        'request.idempotency_key_required',
        400,
        '创建任务必须携带 Idempotency-Key',
      );
    }
    const requestKey = createHash('sha256').update(key).digest('hex');
    const requestHash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
    const existing = await prisma.agentRun.findUnique({
      where: { tokenId_requestKey: { tokenId, requestKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new PluginError('agent.idempotency_conflict', 409, '该幂等键已用于不同任务参数');
      if (parsed.data.execution === 'background' && !['DONE','FAILED','CANCELLED'].includes(existing.status)) await authorizeBackground(request, existing.id);
      reply.header('idempotency-replayed', 'true');
      return { run: toRunView(existing) };
    }
    let caps = await resolveCaps(prisma, tokenId, parsed.data);
    const parent = parsed.data.parentId ? await prisma.agentRun.findFirst({ where: { id: parsed.data.parentId, actorId, tokenId } }) : null;
    if (parsed.data.parentId && (!parent || parent.depth >= 4 || ['FAILED', 'CANCELLED'].includes(parent.status))) throw new PluginError('agent.parent_invalid', 409, '父任务不可派生或已到层级上限');
    if (parent) caps = restrictAgentPolicy(caps, agentPolicySchema.parse(parent.policy));
    const provider = await resolveLlmProvider(app.pluginRuntime);
    if (!provider) throw llmUnconfigured();
    const model =
      (await resolveModel(prisma, parsed.data.model, caps)) ??
      (await provider.listModels()).find((item) => item.supportsTools)?.id;
    if (!model) throw llmUnconfigured();
    if (caps.allowedModels.length && !caps.allowedModels.includes(model)) {
      throw new PluginError('agent.model_not_allowed', 403, '模型不在该凭证的允许名单内');
    }
    if (provider.id === 'configured' && (caps.budgetMinor || caps.dailyBudgetMinor)) {
      throw new PluginError(
        'agent.pricing_unknown',
        409,
        '兜底模型费用未知，无法执行金额预算；请使用步数额度',
      );
    }
    let run;
    try {
      run = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actorId}))`;
        if (parent && await tx.agentRun.count({ where: { rootId: parent.rootId ?? parent.id } }) >= 8) throw new PluginError('agent.children_limit', 429, '同一任务最多派生八个子运行');
        return tx.agentRun.create({
        data: {
          actorId,
          tokenId,
          ...(parent ? { parentId: parent.id, rootId: parent.rootId ?? parent.id, depth: parent.depth + 1 } : {}),
          objective: parsed.data.objective,
          model,
          policy: caps,
          status: 'QUEUED',
          requestKey,
          requestHash,
        },
      });
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      const raced = await prisma.agentRun.findUnique({
        where: { tokenId_requestKey: { tokenId, requestKey } },
      });
      if (!raced || raced.requestHash !== requestHash)
        throw new PluginError('agent.idempotency_conflict', 409, '幂等请求参数冲突');
      reply.header('idempotency-replayed', 'true');
      return { run: toRunView(raced) };
    }
    await writeAudit({
      action: 'agent.run.create',
      resource: 'agent.run',
      resourceId: run.id,
      meta: { agent: { runId: run.id, tokenId, model } },
      ...auditContext(request),
    });
    if (parsed.data.execution === 'background') {
      await authorizeBackground(request, run.id);
      return reply.code(202).send({ run: toRunView(run) });
    }
    const view = await drive(request, run, true);
    return reply.code(201).send({ run: view });
  });

  app.get('/api/v1/agent/runs', { preHandler: authenticated }, async (request) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) throw validationError();
    const limit = query.data.limit ?? 20;
    const rows = await prisma.agentRun.findMany({
      where: { actorId: currentUser(request).id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.data.cursor ? { cursor: { id: query.data.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      runs: page.map(toRunView),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  });
  app.get('/api/v1/agent/runs/:id', { preHandler: authenticated }, async (request) => {
    const run = await ownedRun(request);
    const steps = await prisma.agentStep.findMany({
      where: { runId: run.id },
      orderBy: { index: 'asc' },
    });
    return {
      run: toRunView(run),
      family: await prisma.agentRun.findMany({ where: { OR: [{ id: run.rootId ?? run.id }, { rootId: run.rootId ?? run.id }] }, select: { id: true, parentId: true, status: true, objective: true } }),
      steps: steps.map((step) => ({ ...step, createdAt: step.createdAt.toISOString() })),
    };
  });
  app.post('/api/v1/agent/runs/:id/resume', { preHandler: guard }, async (request, reply) => {
    const run = await ownedRun(request);
    if (!['QUEUED', 'RUNNING', 'WAITING_APPROVAL'].includes(run.status)) {
      throw new PluginError('agent.run.not_resumable', 409, '该运行当前不可继续推进');
    }
    requireOriginalAgentToken(request, run);
    const mode = parseAgent(z.object({ execution: z.enum(['request', 'background']).optional() }).strict(), request.body ?? {});
    if (mode.execution === 'background') { await authorizeBackground(request, run.id); return reply.code(202).send({ run: toRunView(run) }); }
    const view = await drive(request, run);
    await writeAudit({
      action: 'agent.run.resume',
      resource: 'agent.run',
      resourceId: run.id,
      ...auditContext(request),
    });
    return { run: view };
  });
  app.post('/api/v1/agent/runs/:id/cancel', { preHandler: authenticated }, async (request) => {
    const run = await ownedRun(request);
    await prisma.$transaction(async (tx) => {
      const changed = await tx.agentRun.updateMany({
        where: { id: run.id, status: { in: ['QUEUED', 'RUNNING', 'WAITING_APPROVAL'] } },
        data: { status: 'CANCELLED', endedAt: new Date() },
      });
      if (!changed.count) throw new PluginError('agent.run.not_cancellable', 409, '该运行已结束');
      await tx.agentApproval.updateMany({
        where: { runId: run.id, status: 'PENDING' },
        data: { status: 'EXPIRED', decidedAt: new Date(), reason: '运行已取消' },
      });
    });
    await writeAudit({
      action: 'agent.run.cancel',
      resource: 'agent.run',
      resourceId: run.id,
      ...auditContext(request),
    });
    await revokeBackground(run.id);
    await notifyAgent(app.notifications, run.actorId, run.id, {
      key: 'terminal:CANCELLED',
      type: 'agent.run.cancelled',
      title: 'Agent 任务已取消',
      body: run.objective.slice(0, 200),
    });
    return { run: toRunView(await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })) };
  });

  app.get('/api/v1/agent/approvals', { preHandler: authenticated }, async (request) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) throw validationError();
    const user = currentUser(request);
    const caps = await allCapabilities(request);
    const scoped = caps
      .filter((cap) => cap.scope !== null && callerSatisfiesScope(request, cap.scope))
      .map((cap) => cap.id);
    const dangerous = caps.filter((cap) => cap.mutating && (cap.destructive ?? true)).map((cap) => cap.id);
    const identity = caps.filter((cap) => cap.scope === null).map((cap) => cap.id);
    const limit = query.data.limit ?? 20;
    const rows = await prisma.agentApproval.findMany({
      where: {
        status: 'PENDING',
        run: { status: { notIn: ['DONE', 'FAILED', 'CANCELLED'] } },
        OR: [
          { capabilityId: { in: scoped, notIn: dangerous } },
          { capabilityId: { in: dangerous }, run: { actorId: user.id } },
          { capabilityId: { in: identity }, run: { actorId: user.id } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: { run: true },
      ...(query.data.cursor ? { cursor: { id: query.data.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      approvals: page.map((row) => ({
        ...toApprovalView(row),
        run: { id: row.run.id, actorId: row.run.actorId, objective: row.run.objective },
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  });
  app.post('/api/v1/agent/approvals/:id/decide', { preHandler: authenticated }, async (request) => {
    if (currentUser(request).impersonatorId)
      throw new PluginError('agent.impersonation_forbidden', 403, '冒用会话不能审批');
    const params = idParamSchema.safeParse(request.params);
    const body = decideSchema.safeParse(request.body);
    if (!params.success || !body.success) throw validationError();
    const user = currentUser(request);
    const approval = await prisma.agentApproval.findUnique({
      where: { id: params.data.id },
      include: { run: true },
    });
    if (!approval) throw approvalNotFound();
    const capability = await findCapability(request, approval.capabilityId);
    if (!capability)
      throw new PluginError('agent.approval.capability_unavailable', 409, '该能力已不可用');
    const denied = approvalEligibility({
      approverId: user.id,
      runActorId: approval.run.actorId,
      capabilityScope: capability.scope,
      approverSatisfiesScope: callerSatisfiesScope(request, capability.scope),
      destructive: capability.mutating && (capability.destructive ?? true),
    });
    if (denied) throw denied;
    const now = new Date();
    const updated = await prisma.agentApproval.updateMany({
      where: {
        id: approval.id,
        status: 'PENDING',
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        run: { status: { notIn: ['DONE', 'FAILED', 'CANCELLED'] } },
      },
      data: {
        status: body.data.approve ? 'APPROVED' : 'DENIED',
        decidedBy: user.id,
        decidedAt: now,
        ...(body.data.reason !== undefined ? { reason: body.data.reason } : {}),
      },
    });
    if (!updated.count)
      throw new PluginError('agent.approval.conflict', 409, '审批已处理、已过期或运行已结束');
    await prisma.agentDispatch.updateMany({ where: { runId: approval.runId }, data: { pending: true } });
    const result = await prisma.agentApproval.findUniqueOrThrow({ where: { id: approval.id } });
    await writeAudit({
      action: body.data.approve ? 'agent.approval.approve' : 'agent.approval.deny',
      resource: 'agent.approval',
      resourceId: approval.id,
      ...auditContext(request),
    });
    await notifyAgent(app.notifications, approval.run.actorId, approval.runId, {
      key: `approval:${approval.id}`,
      type: 'agent.approval.decided',
      title: body.data.approve ? 'Agent 操作已获确认' : 'Agent 操作已被拒绝',
      body: '决定已记录；请使用原 API Key 继续任务。',
      data: { approvalId: approval.id },
    });
    return { approval: toApprovalView(result), run: toRunView(approval.run) };
  });
}
