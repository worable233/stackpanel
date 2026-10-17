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

/** One user override; `type` is validated against the catalog by the service. */
const preferenceItemsSchema = z.object({
  items: z
    .array(
      z.object({
        type: z.string().trim().min(1).max(200),
        channelId: z.string().trim().min(1).max(64),
        enabled: z.boolean(),
      }),
    )
    .max(500),
});

const resetSchema = z.object({
  types: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
});

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

  app.get('/notifications', { preHandler: requireAuth }, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: '查询参数无效' });
    const result = await notifications.listForUser(currentUser(request).id, {
      ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
      ...(query.data.cursor !== undefined ? { cursor: query.data.cursor } : {}),
      ...(query.data.unreadOnly !== undefined ? { unreadOnly: query.data.unreadOnly } : {}),
    });
    return result;
  });

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

  /*
   * 用户级通知偏好（自身）。
   *
   * `GET` 返回目录 + 该用户解析后的每渠道状态；`PATCH` 写入显式覆盖（锁定的类型/
   * 未声明类型会被服务端忽略）；`DELETE` 清空覆盖回到默认。未声明类型没有配置项，
   * 永远投递、不可关闭。
   */
  app.get('/notifications/preferences', { preHandler: requireAuth }, async (request) => {
    return app.notificationPolicy.listForUser(currentUser(request).id);
  });

  app.patch('/notifications/preferences', { preHandler: requireAuth }, async (request, reply) => {
    const body = preferenceItemsSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: '请求参数无效' });
    await app.notificationPolicy.updateForUser(currentUser(request).id, body.data.items);
    return app.notificationPolicy.listForUser(currentUser(request).id);
  });

  app.post(
    '/notifications/preferences/reset',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = resetSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ error: '请求参数无效' });
      await app.notificationPolicy.resetForUser(
        currentUser(request).id,
        body.data.types && body.data.types.length > 0 ? body.data.types : undefined,
      );
      return app.notificationPolicy.listForUser(currentUser(request).id);
    },
  );
}
