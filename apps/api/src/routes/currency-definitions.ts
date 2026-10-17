import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CurrencyError, formatMinorCurrency } from '@stackpanel/sdk';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { requireAuth, requireRole } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { KernelCurrencyService } from '../currency/service.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const patchCurrencySchema = z.object({
  enabled: z.boolean(),
});

const settlementSchema = z.object({
  currency: z.string().min(1).max(8),
});

/** Render a currency error as a stable problem-details body. */
function currencyErrorBody(error: CurrencyError): { error: string; code: string } {
  return { error: error.message, code: error.code };
}

export async function currencyDefinitionRoutes(app: FastifyInstance): Promise<void> {
  // Public: enabled currencies with display metadata (pickers + formatting).
  app.get('/currency-definitions', async () => {
    const service = new KernelCurrencyService({ db: getPrisma() });
    const definitions = await service.listEnabled();
    return {
      currencies: definitions.map((definition) => ({
        code: definition.code,
        name: definition.name,
        symbol: definition.symbol,
        minorUnit: definition.minorUnit,
      })),
    };
  });

  // Admin: all currencies plus whether they are still referenced by data.
  app.get('/admin/currency-definitions', { preHandler: adminOnly }, async () => {
    const service = new KernelCurrencyService({ db: getPrisma() });
    const [definitions, references, settlement] = await Promise.all([
      service.list(),
      service.referenceStatus(),
      service.getSettlementCurrency(),
    ]);
    return {
      currencies: definitions.map((definition) => ({
        ...definition,
        referenced: references[definition.code] === true,
        settlement: definition.code === settlement,
        sample: formatMinorCurrency(
          123_45 * Math.max(1, definition.minorUnit),
          definition.code,
          'en-US',
        ),
      })),
      settlementCurrency: settlement,
    };
  });

  app.patch<{ Params: { code: string } }>(
    '/admin/currency-definitions/:code',
    { preHandler: adminOnly },
    async (request, reply) => {
      const parsed = patchCurrencySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: '请求参数无效' });
      const service = new KernelCurrencyService({ db: getPrisma() });
      try {
        const updated = await service.setEnabled(request.params.code, parsed.data.enabled);
        await writeAudit({
          action: parsed.data.enabled ? 'currency.enable' : 'currency.disable',
          resource: 'currency_definition',
          resourceId: updated.code,
          meta: { enabled: updated.enabled },
          ...auditContext(request),
        });
        const [references, settlement] = await Promise.all([
          service.referenceStatus(),
          service.getSettlementCurrency(),
        ]);
        return {
          currency: {
            ...updated,
            referenced: references[updated.code] === true,
            settlement: updated.code === settlement,
            sample: formatMinorCurrency(
              123_45 * Math.max(1, updated.minorUnit),
              updated.code,
              'en-US',
            ),
          },
        };
      } catch (error) {
        if (error instanceof CurrencyError) {
          return reply.code(error.status).send(currencyErrorBody(error));
        }
        throw error;
      }
    },
  );

  // Settlement currency is a platform setting with dedicated validation.
  app.get('/admin/settings/settlement-currency', { preHandler: adminOnly }, async () => {
    const service = new KernelCurrencyService({ db: getPrisma() });
    const [settlement, definitions] = await Promise.all([
      service.getSettlementCurrency(),
      service.listEnabled(),
    ]);
    return {
      settlementCurrency: settlement,
      candidates: definitions.map((definition) => ({
        code: definition.code,
        name: definition.name,
        symbol: definition.symbol,
        minorUnit: definition.minorUnit,
      })),
    };
  });

  app.put(
    '/admin/settings/settlement-currency',
    { preHandler: adminOnly },
    async (request, reply) => {
      const parsed = settlementSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: '请求参数无效' });
      const service = new KernelCurrencyService({ db: getPrisma() });
      try {
        // Compatibility guard (plan §4.3/§5.3): every enabled payment method must
        // be able to collect the new settlement currency, and the wallet must
        // match it unless the wallet also supports the target currency.
        const settlement = await service.setSettlementCurrency(
          parsed.data.currency,
          request.user?.id ?? null,
        );
        await writeAudit({
          action: 'currency.settlement.set',
          resource: 'setting',
          resourceId: 'currency.settlement',
          meta: { currency: settlement },
          ...auditContext(request),
        });
        return { settlementCurrency: settlement };
      } catch (error) {
        if (error instanceof CurrencyError) {
          return reply.code(error.status).send(currencyErrorBody(error));
        }
        throw error;
      }
    },
  );
}
