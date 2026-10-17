import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CurrencyError, normalizeCurrencyCode } from '@stackpanel/sdk';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';
import { KernelCurrencyService } from '../../currency/service.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const setRateSchema = z.object({
  fromCurrency: z.string().min(1).max(8),
  /** Omitted → the platform settlement currency. */
  toCurrency: z.string().min(1).max(8).optional(),
  /** from→to, scaled ×1e6. */
  rate: z.number().int().positive(),
  /** Optional expiry; expired rates are refused for new orders. */
  validUntil: z.coerce.date().nullish(),
});

/** Render a currency error as a stable problem-details body. */
function currencyErrorBody(error: CurrencyError): { error: string; code: string } {
  return { error: error.message, code: error.code };
}

export async function adminCurrencyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/currency-rates', { preHandler: adminOnly }, async () => {
    const prisma = getPrisma();
    const service = new KernelCurrencyService({ db: prisma });
    const [rates, settlement] = await Promise.all([
      prisma.fxRate.findMany({ orderBy: { fromCurrency: 'asc' } }),
      service.getSettlementCurrency(),
    ]);
    return {
      settlementCurrency: settlement,
      rates: rates.map((r) => ({
        id: r.id,
        fromCurrency: r.fromCurrency,
        toCurrency: r.toCurrency,
        rate: r.rate,
        source: r.source,
        validUntil: r.validUntil,
        updatedAt: r.updatedAt,
      })),
    };
  });

  app.put('/admin/currency-rates', { preHandler: adminOnly }, async (request, reply) => {
    const parsed = setRateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请求参数无效' });
    const prisma = getPrisma();
    const service = new KernelCurrencyService({ db: prisma });
    const toDefault = await service.getSettlementCurrency();
    // Catalog validation: neither side may be a free-text code or a disabled
    // currency (`currency.invalid` / `currency.disabled`).
    let fromCurrency: string;
    let toCurrency: string;
    try {
      fromCurrency = (await service.requireEnabled(parsed.data.fromCurrency)).code;
      toCurrency = (await service.requireEnabled(parsed.data.toCurrency ?? toDefault)).code;
    } catch (error) {
      if (error instanceof CurrencyError) {
        return reply.code(error.status).send(currencyErrorBody(error));
      }
      throw error;
    }
    if (fromCurrency === toCurrency) {
      return reply.code(400).send({ error: '同币种无需配置汇率', code: 'currency.invalid' });
    }
    // FX only converts native → settlement (plan §4.3): refuse an inverted pair
    // so no reverse/arbitrage path is invented.
    if (toCurrency !== toDefault) {
      return reply.code(409).send({
        error: `汇率目标必须是平台结算币种（${toDefault}）`,
        code: 'currency.settlement_unsupported',
      });
    }
    const row = await prisma.fxRate.upsert({
      where: { fromCurrency_toCurrency: { fromCurrency, toCurrency } },
      create: {
        fromCurrency,
        toCurrency,
        rate: parsed.data.rate,
        validUntil: parsed.data.validUntil ?? null,
        source: 'manual',
        updatedBy: request.user?.id ?? null,
      },
      update: {
        rate: parsed.data.rate,
        validUntil: parsed.data.validUntil ?? null,
        updatedBy: request.user?.id ?? null,
      },
    });
    await writeAudit({
      action: 'fx.rate.set',
      resource: 'fx_rate',
      resourceId: row.id,
      meta: {
        fromCurrency,
        toCurrency,
        rate: row.rate,
        validUntil: row.validUntil?.toISOString() ?? null,
      },
      ...auditContext(request),
    });
    return {
      id: row.id,
      fromCurrency: row.fromCurrency,
      toCurrency: row.toCurrency,
      rate: row.rate,
      source: row.source,
      validUntil: row.validUntil,
      updatedAt: row.updatedAt,
    };
  });

  app.delete('/admin/currency-rates', { preHandler: adminOnly }, async (request, reply) => {
    const parsed = z
      .object({ fromCurrency: z.string().min(1).max(8), toCurrency: z.string().min(1).max(8) })
      .safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: '请求参数无效' });
    const fromCurrency = normalizeCurrencyCode(parsed.data.fromCurrency);
    const toCurrency = normalizeCurrencyCode(parsed.data.toCurrency);
    if (!fromCurrency || !toCurrency) {
      return reply.code(400).send({ error: '请求参数无效', code: 'currency.invalid' });
    }
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
