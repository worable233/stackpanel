import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentUser, requireAuth } from '../plugins/auth.ts';
import { getEventBus } from '../plugins/events.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { KernelNotificationsService } from '../notifications/notifications-service.ts';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().max(191).optional(),
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

const idParamSchema = z.object({ id: z.string().min(1).max(191) });

/**
 * Kernel-owned in-app notification endpoints. Available to any authenticated
 * user (both the account center and the admin console read the same inbox,
 * scoped to the session's user id).
 */
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const notifications = new KernelNotificationsService({
    db: getPrisma(),
    events: getEventBus(),
  });

  app.get(
    '/notifications',
    { preHandler: requireAuth },
    async (request, reply) => {
      const query = listQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: '查询参数无效' });
      const result = await notifications.listForUser(currentUser(request).id, {
        ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
        ...(query.data.cursor !== undefined ? { cursor: query.data.cursor } : {}),
        ...(query.data.unreadOnly !== undefined ? { unreadOnly: query.data.unreadOnly } : {}),
      });
      return result;
    },
  );

  app.get('/notifications/unread-count', { preHandler: requireAuth }, async (request) => {
    const unreadCount = await notifications.unreadCount(currentUser(request).id);
    return { unreadCount };
  });

  app.post('/notifications/:id/read', { preHandler: requireAuth }, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: '通知 ID 无效' });
    const updated = await notifications.markRead(currentUser(request).id, params.data.id);
    if (!updated) return reply.code(404).send({ error: '通知不存在' });
    return reply.code(204).send();
  });

  app.post('/notifications/read-all', { preHandler: requireAuth }, async (request) => {
    const count = await notifications.markAllRead(currentUser(request).id);
    return { count };
  });
}
