import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

export async function adminPaymentsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/admin/payments/:id/confirm', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
    const appPayments = request.server.payments;
    const result = await appPayments.confirmManual(params.data.id);
    if (result.confirmed) {
      await writeAudit({
        action: 'payment.confirm',
        resource: 'payment',
        resourceId: params.data.id,
        ...auditContext(request),
      });
      return { confirmed: true };
    }
    return reply.code(409).send({ confirmed: false, reason: result.reason });
  });

  app.post('/admin/payments/:id/cancel', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
    const appPayments = request.server.payments;
    const result = await appPayments.cancelManual(params.data.id);
    if (result.cancelled) {
      await writeAudit({
        action: 'payment.cancel',
        resource: 'payment',
        resourceId: params.data.id,
        ...auditContext(request),
      });
      return { cancelled: true };
    }
    return reply.code(409).send({ cancelled: false, reason: result.reason });
  });

  // List manual payments pending review (PENDING manual methods).
  app.get('/admin/payments/manual', { preHandler: adminOnly }, async () => {
    const prisma = getPrisma();
    const payments = await prisma.payment.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { payments };
  });
}
