import type { Prisma } from '@stackpanel/db';
import { createHash } from 'node:crypto';
import type { NotificationsService, NotificationStatus } from '@stackpanel/sdk';
import { getPrisma } from '../plugins/prisma.ts';

type AgentNotice = { key: string; type: string; title: string; body: string; status?: NotificationStatus; link?: string; data?: Record<string, unknown> };

/** Persist before attempting delivery; failures remain available to the kernel sweep. */
export async function notifyAgent(service: NotificationsService, userId: string, runId: string, input: AgentNotice): Promise<void> {
  const id = createHash('sha256').update(`${userId}:${runId}:${input.key}:${input.type}`).digest('hex');
  await getPrisma().agentDelivery.upsert({ where: { id }, create: { id, userId, runId, payload: input as unknown as Prisma.InputJsonValue }, update: {} });
  await deliverAgentNotice(service, id);
}

async function deliverAgentNotice(service: NotificationsService, id: string): Promise<void> {
  const db = getPrisma(); const row = await db.agentDelivery.findUnique({ where: { id } });
  if (!row || row.deliveredAt) return;
  // Conditional due-date claim serializes replicas without losing the durable intent.
  const claim = await db.agentDelivery.updateMany({ where: { id, deliveredAt: null, nextAttemptAt: { lte: new Date() } },
    data: { nextAttemptAt: new Date(Date.now() + 60_000), attempts: { increment: 1 } } });
  if (!claim.count) return;
  const input = row.payload as unknown as AgentNotice;
  try {
    const approvalId = input.data?.approvalId;
    const approval = input.type === 'agent.approval.pending' && typeof approvalId === 'string'
      ? await db.agentApproval.findUnique({ where: { id: approvalId } }) : null;
    const owner = await db.user.findUnique({where:{id:row.userId},select:{id:true}});
    if (owner && (input.type !== 'agent.approval.pending' || approval?.status === 'PENDING')) {
      await service.upsert({ userId: row.userId, dedupeKey: `agent:${row.runId}:${input.key}`, type: input.type,
        title: input.title, body: input.body, status: input.status ?? 'info',
        link: input.link ?? `/account/agent/runs/${row.runId}`, data: { runId: row.runId, ...input.data } });
    }
    await db.agentDelivery.update({ where: { id }, data: { deliveredAt: new Date() } });
  } catch {
    await db.agentDelivery.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() + Math.min(3600_000, 1000 * 2 ** Math.min(row.attempts, 12))) } });
  }
}

export async function retryAgentNotices(service: NotificationsService): Promise<void> {
  const rows = await getPrisma().agentDelivery.findMany({ where: { deliveredAt: null, nextAttemptAt: { lte: new Date() } }, orderBy: { createdAt: 'asc' }, take: 50 });
  for (const row of rows) await deliverAgentNotice(service, row.id);
}
