import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PluginError, type AgentRunStatus } from '@stackpanel/sdk';
import { getPrisma } from '../plugins/prisma.ts';
import { currentUser } from '../plugins/auth.ts';
import { decryptSecret, encryptSecret, isSecretsEnabled } from '../lib/crypto.ts';
import { getJobRuntime } from '../jobs/kernel-jobs.ts';
import { notifyAgent, retryAgentNotices } from '../notifications/agent-notifications.ts';

const keyFor = (runId: string) => `agent.dispatch.${runId}`;
const terminal: AgentRunStatus[] = ['DONE', 'FAILED', 'CANCELLED'];

export async function authorizeBackground(request: FastifyRequest, runId: string): Promise<void> {
  const user = currentUser(request);
  if (!user.tokenId || !user.viaApiToken || user.impersonatorId || !request.headers.authorization) throw new PluginError('agent.token_required', 400, '后台执行需要原 API Key');
  if (!isSecretsEnabled()) throw new PluginError('secret.storage.disabled', 501, '后台执行需要加密密钥存储');
  const db = getPrisma();
  const tokenId = user.tokenId;
  await db.$transaction(async (tx) => {
    const run = await tx.agentRun.findFirst({ where: { id: runId, actorId: user.id, tokenId } });
    if (!run || terminal.includes(run.status)) throw new PluginError('agent.run.not_resumable', 409, '运行已结束或凭证不匹配');
    await tx.secret.upsert({ where: { key: keyFor(runId) }, create: { key: keyFor(runId), ciphertext: encryptSecret(request.headers.authorization as string) }, update: { ciphertext: encryptSecret(request.headers.authorization as string) } });
    await tx.agentDispatch.upsert({ where: { runId }, create: { runId, actorId: user.id, clientIp: request.ip, expiresAt: new Date(Date.now() + 3600_000) },
      update: { pending: true, clientIp: request.ip } });
  });
  // The persistent sweep is authoritative if enqueue fails or the process restarts.
  await getJobRuntime().enqueue('kernel.agent.advance', { runId }).catch(() => undefined);
}

export async function revokeBackground(runId: string): Promise<void> {
  await getPrisma().$transaction([
    getPrisma().secret.deleteMany({ where: { key: keyFor(runId) } }),
    getPrisma().agentDispatch.deleteMany({ where: { runId } }),
  ]);
}

export async function advanceBackground(app: FastifyInstance, runId: string): Promise<void> {
  const db = getPrisma(); const now = new Date();
  const dispatch = await db.agentDispatch.findUnique({ where: { runId } });
  if (!dispatch || !dispatch.pending) return;
  const lockUntil = new Date(Date.now() + 120_000);
  const claim = await db.agentDispatch.updateMany({ where: { runId, pending: true, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: lockUntil, attempts: { increment: 1 } } });
  if (!claim.count) return;
  // CAS ownership prevents a late worker from releasing a successor's claim.
  let lease = lockUntil;
  const renewal = setInterval(() => {
    const next = new Date(Date.now() + 120_000);
    void db.agentDispatch.updateMany({ where: { runId, lockedUntil: lease }, data: { lockedUntil: next } }).then((row) => { if (row.count) lease = next; }).catch(() => undefined);
  }, 30_000);
  renewal.unref();
  try {
    const run = await db.agentRun.findUnique({ where: { id: runId } });
    if (!run || terminal.includes(run.status)) { await revokeBackground(runId); return; }
    if (dispatch.expiresAt <= now) {
      await db.agentRun.updateMany({ where: { id: runId, status: { notIn: terminal } }, data: { status: 'FAILED', endedAt: now, error: '后台授权已到期，请新建任务' } });
      await revokeBackground(runId); return;
    }
    const secret = await db.secret.findUnique({ where: { key: keyFor(runId) } });
    if (!secret) { await revokeBackground(runId); return; }
    const response = await app.inject({ method: 'POST', url: `/api/v1/agent/runs/${runId}/resume`,
      headers: { authorization: decryptSecret(secret.ciphertext) }, remoteAddress: dispatch.clientIp, payload: { execution: 'request' } });
    if (response.statusCode === 409 && response.json().code === 'agent.run.busy') return;
    if (response.statusCode >= 400 && response.statusCode < 500) {
      await db.agentRun.updateMany({ where: { id: runId, status: { notIn: terminal } }, data: { status: 'FAILED', endedAt: new Date(), error: '后台执行授权已失效或任务不能继续，请核对凭证及站点状态' } });
      await revokeBackground(runId); return;
    }
    if (response.statusCode >= 500) throw new Error('后台推进暂时失败');
    const latest = await db.agentRun.findUnique({ where: { id: runId } });
    if (!latest || terminal.includes(latest.status)) await revokeBackground(runId);
    else await db.agentDispatch.updateMany({ where: { runId }, data: { pending: latest.status !== 'WAITING_APPROVAL' } });
  } finally { clearInterval(renewal); await db.agentDispatch.updateMany({ where: { runId, lockedUntil: lease }, data: { lockedUntil: null } }); }
}

export async function sweepAgents(app: FastifyInstance): Promise<void> {
  const db = getPrisma();
  await db.agentApproval.updateMany({ where: { status: 'PENDING', expiresAt: { lte: new Date() } }, data: { status: 'EXPIRED', decidedAt: new Date(), reason: '审批超时' } });
  const parked = await db.$queryRaw<Array<{runId:string}>>`SELECT d."runId" FROM agent_dispatches d WHERE NOT d.pending AND NOT EXISTS (SELECT 1 FROM agent_approvals a WHERE a."runId" = d."runId" AND a.status = 'PENDING') ORDER BY d."updatedAt" ASC LIMIT 100`;
  for (const row of parked) {
    const pending = await db.agentApproval.count({ where: { runId: row.runId, status: 'PENDING' } });
    if (!pending) await db.agentDispatch.updateMany({ where: { runId: row.runId }, data: { pending: true } });
  }
  const rows = await db.agentDispatch.findMany({ where: { pending: true, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] }, orderBy: { createdAt: 'asc' }, take: 20 });
  await Promise.allSettled(rows.map((row) => advanceBackground(app, row.runId)));
  await db.agentOAuthGrant.deleteMany({where:{expiresAt:{lt:new Date(Date.now()-86400_000)}}});
  await retryAgentNotices(app.notifications);
  // Reconstruct notices after a process died between terminal persistence and enqueue.
  const missing = await db.$queryRaw<Array<{id: string}>>`SELECT r.id FROM agent_runs r WHERE r.status IN ('DONE','FAILED','CANCELLED') AND NOT EXISTS (SELECT 1 FROM agent_deliveries d WHERE d."runId" = r.id AND d.payload->>'key' = 'terminal:' || r.status::text) ORDER BY r."endedAt" ASC LIMIT 100`;
  const finished = await db.agentRun.findMany({ where: { id: { in: missing.map((row) => row.id) } } });
  const pending = await db.$queryRaw<Array<{id:string;runId:string;actorId:string;capabilityId:string}>>`SELECT a.id, a."runId", r."actorId", a."capabilityId" FROM agent_approvals a JOIN agent_runs r ON r.id = a."runId" WHERE a.status = 'PENDING' AND NOT EXISTS (SELECT 1 FROM agent_deliveries d WHERE d."runId" = r.id AND d.payload->>'key' = 'approval:' || a.id) ORDER BY a."createdAt" ASC LIMIT 100`;
  for (const row of pending) await notifyAgent(app.notifications, row.actorId, row.runId, { key: `approval:${row.id}`, type: 'agent.approval.pending', title: 'Agent 操作等待确认', body: `请求执行 ${row.capabilityId}`, link: '/account/agent/approvals', data: { approvalId: row.id } });
  for (const run of finished) await notifyAgent(app.notifications, run.actorId, run.id, { key: `terminal:${run.status}`, type: `agent.run.${run.status.toLowerCase()}`, title: run.status === 'DONE' ? 'Agent 任务已完成' : run.status === 'FAILED' ? 'Agent 任务失败' : 'Agent 任务已取消', body: run.error ?? '请查看任务执行结果' });
}

export function registerAgentJobs(app: FastifyInstance): void {
  const jobs = getJobRuntime();
  jobs.handle('kernel.agent.advance', async (payload) => { const id = (payload as { runId?: unknown })?.runId; if (typeof id === 'string') await advanceBackground(app, id); });
  jobs.handle('kernel.agent.sweep', async () => { await sweepAgents(app); });
  app.addHook('onReady', async () => { await jobs.schedule({ fullName: 'kernel.agent.sweep', schedule: { everyMs: 5000 }, payload: {} }); });
}
