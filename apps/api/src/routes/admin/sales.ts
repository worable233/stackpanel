import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@stackpanel/db';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const channelSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
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
  config: z.json(),
  sortOrder: z.number().int().default(0),
});

export async function adminSalesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/sales-channels', { preHandler: adminOnly }, async () => {
    const prisma = getPrisma();
    const channels = await prisma.salesChannel.findMany({
      include: { methods: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { sortOrder: 'asc' },
    });
    return { channels };
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
    const prisma = getPrisma();
    const method = await prisma.paymentMethod.create({
      data: {
        ...parsed.data,
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
    const { config, ...rest } = body.data;
    const data: Record<string, unknown> = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    if (config !== undefined) data.config = config as Prisma.InputJsonValue;
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
