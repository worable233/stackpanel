import type { FastifyInstance } from 'fastify';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

/** Read-only: all declared permissions contributed by plugins and the platform. */
export async function adminPermissionsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/permissions', { preHandler: adminOnly }, async () => {
    const prisma = getPrisma();
    const permissions = await prisma.permission.findMany({ orderBy: { key: 'asc' } });
    return {
      permissions: permissions.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        description: p.description,
      })),
    };
  });
}
