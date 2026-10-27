import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CurrencyError } from '@stackpanel/sdk';
import { KernelCurrencyService } from '../../currency/service.ts';
import type { Prisma } from '@stackpanel/db';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

/**
 * Normalize a payment method's currency allow-list against the catalog. Free
 * text is refused (plan §4.1/§4.4); an empty list still means "all enabled".
 */
async function normalizeMethodCurrencies(codes: string[]): Promise<string[]> {
  const service = new KernelCurrencyService({ db: getPrisma() });
  const normalized: string[] = [];
  for (const code of codes) {
    const definition = await service.requireEnabled(code);
    if (!normalized.includes(definition.code)) normalized.push(definition.code);
  }
  return normalized;
}

/** Render a currency error as a stable problem-details body. */
function currencyErrorBody(error: CurrencyError): { error: string; code: string } {
  return { error: error.message, code: error.code };
}

const channelSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  name: z.string().min(1).max(100),
  terminal: z.enum(['PC', 'MINI_PROGRAM', 'API']).default('PC'),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const methodSchema = z.object({
  channelId: z.string().min(1),
  providerId: z.string().min(1),
  name: z.string().min(1).max(100),
  enabled: z.boolean().default(true),
  scene: z.string().default('PC'),
  /** Settlement currencies this method can collect; empty = all enabled. */
  currencies: z.array(z.string().min(1).max(8)).default([]),
  config: z.json(),
  sortOrder: z.number().int().default(0),
});

export async function adminSalesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/sales-channels', { preHandler: adminOnly }, async (request) => {
    const prisma = getPrisma();
    const channels = await prisma.salesChannel.findMany({
      include: { methods: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { sortOrder: 'asc' },
    });
    /*
     * Tell the admin UI which provider family each row belongs to.
     *
     * A manual provider (bank transfer / QR) has no gateway: the row's `config`
     * is the entire payment step, so a row without collection details is a dead
     * end for the buyer and deserves a warning. A gateway provider (epay and
     * friends) keeps its credentials in its own plugin settings, so empty
     * `config` is normal — warning there would train operators to ignore the
     * warning. `mode` comes from the live runtime, not from the row.
     */
    const listing = request.server.payments.listPaymentMethods();
    const modes = new Map(listing.providers.map((provider) => [provider.id, provider.mode]));
    return {
      // The installable provider catalogue, so the admin UI can offer a picker
      // instead of a free-text id (a typo there is only caught on save).
      providers: listing.providers,
      channels: channels.map((channel) => ({
        ...channel,
        methods: channel.methods.map((method) => ({
          ...method,
          providerMode: modes.get(method.providerId) ?? null,
        })),
      })),
    };
  });

  app.post('/admin/sales-channels', { preHandler: adminOnly }, async (request, reply) => {
    const parsed = channelSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请求参数无效' });
    const prisma = getPrisma();
    try {
      const channel = await prisma.salesChannel.create({ data: parsed.data });
      await writeAudit({
        action: 'sales.channel.create',
        resource: 'sales_channel',
        resourceId: channel.id,
        ...auditContext(request),
      });
      return { channel };
    } catch {
      return reply.code(409).send({ error: '渠道编码已存在' });
    }
  });

  app.patch('/admin/sales-channels/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = channelSchema.partial().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: '请求参数无效' });
    const prisma = getPrisma();
    const data = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined));
    const channel = await prisma.salesChannel.update({
      where: { id: params.data.id },
      data,
    });
    await writeAudit({
      action: 'sales.channel.update',
      resource: 'sales_channel',
      resourceId: channel.id,
      ...auditContext(request),
    });
    return { channel };
  });

  app.delete('/admin/sales-channels/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
    const prisma = getPrisma();
    await prisma.salesChannel.delete({ where: { id: params.data.id } });
    await writeAudit({
      action: 'sales.channel.delete',
      resource: 'sales_channel',
      resourceId: params.data.id,
      ...auditContext(request),
    });
    return { deleted: true };
  });

  app.post('/admin/payment-methods', { preHandler: adminOnly }, async (request, reply) => {
    const parsed = methodSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: '请求参数无效' });
    let currencies: string[];
    try {
      currencies = await normalizeMethodCurrencies(parsed.data.currencies);
    } catch (error) {
      if (error instanceof CurrencyError) {
        return reply.code(error.status).send(currencyErrorBody(error));
      }
      throw error;
    }
    const prisma = getPrisma();
    const method = await prisma.paymentMethod.create({
      data: {
        ...parsed.data,
        currencies,
        config: parsed.data.config as Prisma.InputJsonValue,
      },
    });
    await writeAudit({
      action: 'sales.method.create',
      resource: 'payment_method',
      resourceId: method.id,
      ...auditContext(request),
    });
    return { method };
  });

  app.patch('/admin/payment-methods/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = methodSchema.partial().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: '请求参数无效' });
    const prisma = getPrisma();
    const { config, currencies, ...rest } = body.data;
    const data: Record<string, unknown> = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    if (config !== undefined) data.config = config as Prisma.InputJsonValue;
    if (currencies !== undefined) {
      try {
        data.currencies = await normalizeMethodCurrencies(currencies);
      } catch (error) {
        if (error instanceof CurrencyError) {
          return reply.code(error.status).send(currencyErrorBody(error));
        }
        throw error;
      }
    }
    const method = await prisma.paymentMethod.update({
      where: { id: params.data.id },
      data: data as Prisma.PaymentMethodUpdateInput,
    });
    await writeAudit({
      action: 'sales.method.update',
      resource: 'payment_method',
      resourceId: method.id,
      ...auditContext(request),
    });
    return { method };
  });

  app.delete('/admin/payment-methods/:id', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
    const prisma = getPrisma();
    await prisma.paymentMethod.delete({ where: { id: params.data.id } });
    await writeAudit({
      action: 'sales.method.delete',
      resource: 'payment_method',
      resourceId: params.data.id,
      ...auditContext(request),
    });
    return { deleted: true };
  });
}
