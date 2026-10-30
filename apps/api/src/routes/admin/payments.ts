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

  /**
   * List payment records for operators.
   *
   * A manual provider never redirects the buyer anywhere, so "confirm receipt"
   * is the whole settlement step — and the record id only ever surfaced inside
   * one buyer's own order page, which made that step unreachable in practice.
   * Rows therefore carry the buyer, the collection method and the order link
   * instead of raw columns.
   *
   * `mode` filters on the provider contract rather than on a hard-coded id list,
   * so a newly installed manual provider shows up automatically.
   */
  app.get('/admin/payments', { preHandler: adminOnly }, async (request, reply) => {
    const query = z
      .object({
        status: z.string().min(1).max(32).optional(),
        mode: z.enum(['gateway', 'manual']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: '请求参数无效' });
    const { status, mode, page, pageSize } = query.data;

    const prisma = getPrisma();
    const providerModes = request.server.payments.providerModes();
    const manualProviderIds = Object.entries(providerModes)
      .filter(([, value]) => value === 'manual')
      .map(([id]) => id);

    // Only constrain provider when a mode was asked for; otherwise every record
    // (including provider-less wallet rows) stays visible.
    const where = {
      ...(status ? { status } : {}),
      ...(mode === 'manual'
        ? { providerId: { in: manualProviderIds } }
        : mode === 'gateway'
          ? { providerId: { notIn: manualProviderIds } }
          : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { method: { select: { name: true } } },
      }),
      prisma.payment.count({ where }),
    ]);

    const buyerIds = [...new Set(rows.map((row) => row.userId))];
    const buyers = buyerIds.length
      ? await prisma.user.findMany({
          where: { id: { in: buyerIds } },
          select: { id: true, email: true },
        })
      : [];
    const emails = new Map(buyers.map((buyer) => [buyer.id, buyer.email]));

    return {
      payments: rows.map((row) => ({
        id: row.id,
        purpose: row.purpose === 'TOP_UP' ? 'TOP_UP' : 'ORDER',
        status: row.status,
        amount: row.amount,
        currency: row.currency,
        orderAmount: row.orderAmount ?? null,
        orderCurrency: row.orderCurrency ?? null,
        providerId: row.providerId ?? null,
        providerMode: row.providerId ? (providerModes[row.providerId] ?? null) : null,
        paymentMethod: row.paymentMethod ?? null,
        methodName: row.method?.name ?? null,
        orderId: row.orderId ?? null,
        buyerId: row.userId,
        buyerEmail: emails.get(row.userId) ?? null,
        externalId: row.externalId ?? null,
        paymentUrl: row.paymentUrl ?? null,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      })),
      total,
      page,
      pageSize,
    };
  });
}
