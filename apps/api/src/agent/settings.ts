import type { FastifyInstance } from 'fastify';
import { PluginError } from '@stackpanel/sdk';
import { currentUser, requireAuth, requireRole } from '../plugins/auth.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { parseAgent } from './validation.ts';
import {
  cleanupConversations,
  retentionSchema,
  retentionView,
  RETENTION_KEY,
} from './retention.ts';

export async function agentSettingsRoutes(app: FastifyInstance) {
  const db = getPrisma();
  const admin = [requireAuth, requireRole('ADMIN')];
  const writable = [
    ...admin,
    async (request: Parameters<typeof currentUser>[0]) => {
      if (currentUser(request).impersonatorId)
        throw new PluginError('agent.impersonation_forbidden', 403, '冒用会话不能修改 Agent 设置');
    },
  ];
  app.get('/admin/agent/retention', { preHandler: admin }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return retentionView(db);
  });
  app.put('/admin/agent/retention', { preHandler: writable }, async (request) => {
    const value = parseAgent(retentionSchema, request.body);
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${RETENTION_KEY}))`;
      await tx.setting.upsert({
        where: { key: RETENTION_KEY },
        create: { key: RETENTION_KEY, value, updatedBy: currentUser(request).id },
        update: { value, updatedBy: currentUser(request).id },
      });
    });
    await writeAudit({
      action: 'agent.retention.update',
      resource: 'setting',
      resourceId: RETENTION_KEY,
      meta: value,
      ...auditContext(request),
    });
    return retentionView(db);
  });
  app.post('/admin/agent/retention/cleanup', { preHandler: writable }, async (request) => {
    const result = await cleanupConversations(db);
    await writeAudit({
      action: 'agent.retention.cleanup',
      resource: 'setting',
      resourceId: RETENTION_KEY,
      meta: result,
      ...auditContext(request),
    });
    return { result, ...(await retentionView(db)) };
  });
}
