import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  action: z.string().trim().max(64).optional(),
  resource: z.string().trim().max(64).optional(),
  actorId: z.string().trim().max(64).optional(),
});

export async function adminAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/audit-log',
    {
      preHandler: adminOnly,
      schema: {
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'number' },
            pageSize: { type: 'number' },
            action: { type: 'string' },
            resource: { type: 'string' },
            actorId: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: '查询参数无效' });
      }
      const { page, pageSize, action, resource, actorId } = query.data;
      const where = {
        ...(action ? { action } : {}),
        ...(resource ? { resource } : {}),
        ...(actorId ? { actorId } : {}),
      };
      const prisma = getPrisma();
      const [logs, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          skip: (page - 1) * pageSize,
          take: pageSize,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.auditLog.count({ where }),
      ]);
      return { logs, total, page, pageSize };
    },
  );
}
