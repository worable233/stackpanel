import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const setRateSchema = z.object({
  fromCurrency: z.string().length(3),
  toCurrency: z.string().length(3).default('CNY'),
  /** from→to, scaled ×1e6. */
  rate: z.number().int().positive(),
});

export async function adminCurrencyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/currency-rates', { preHandler: adminOnly }, async () => {
    const prisma = getPrisma();
    const rates = await prisma.fxRate.findMany({ orderBy: { fromCurrency: 'asc' } });
    return {
      rates: rates.map((r) => ({
        id: r.id,
        fromCurrency: r.fromCurrency,
        toCurrency: r.toCurrency,
        rate: r.rate,
        source: r.source,
        updatedAt: r.updatedAt,
      })),
    };
  });

  app.put('/admin/currency-rates', { preHandler: adminOnly }, async (request, reply) => {
    const parsed = setRateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请求参数无效' });
    const { fromCurrency, toCurrency, rate } = parsed.data;
    if (fromCurrency === toCurrency) {
      return reply.code(400).send({ error: '同币种无需配置汇率' });
    }
    const prisma = getPrisma();
    const row = await prisma.fxRate.upsert({
      where: { fromCurrency_toCurrency: { fromCurrency, toCurrency } },
      create: {
        fromCurrency,
        toCurrency,
        rate,
        source: 'manual',
        updatedBy: request.user?.id ?? null,
      },
      update: { rate, updatedBy: request.user?.id ?? null },
    });
    await writeAudit({
      action: 'fx.rate.set',
      resource: 'fx_rate',
      resourceId: row.id,
      meta: { fromCurrency, toCurrency, rate },
      ...auditContext(request),
    });
    return {
      id: row.id,
      fromCurrency: row.fromCurrency,
      toCurrency: row.toCurrency,
      rate: row.rate,
      source: row.source,
    };
  });

  app.delete('/admin/currency-rates', { preHandler: adminOnly }, async (request, reply) => {
    const parsed = z
      .object({ fromCurrency: z.string().length(3), toCurrency: z.string().length(3) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请求参数无效' });
    const { fromCurrency, toCurrency } = parsed.data;
    const prisma = getPrisma();
    await prisma.fxRate.deleteMany({ where: { fromCurrency, toCurrency } });
    await writeAudit({
      action: 'fx.rate.delete',
      resource: 'fx_rate',
      meta: { fromCurrency, toCurrency },
      ...auditContext(request),
    });
    return { deleted: true };
  });
}
