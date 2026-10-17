import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NotificationPolicyPatch } from '@stackpanel/sdk';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

/**
 * 管理员级通知策略（审计 §5 后续项：事件→渠道映射 / 订阅偏好）。
 *
 * 决定每个通知类型的**全局**开关、默认投递渠道与是否锁定（锁定后用户不可覆盖）。
 * 用户级覆盖在 `/notifications/preferences`。最终裁决由内核
 * `NotificationPolicyService` 完成：管理员策略是天花板/地板，用户覆盖只在
 * 仍可配置的渠道上生效。
 *
 * 未声明（不在目录中）的类型没有配置项，永远投递、不可关闭——这样验证码之类的
 * 一次性事务消息天然不受影响（它们也不经过通知服务）。
 */
const patchSchema = z.object({
  types: z
    .record(
      z.string().trim().min(1).max(200),
      z.object({
        enabled: z.boolean().optional(),
        defaultChannels: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
        locked: z.boolean().optional(),
      }),
    )
    .optional(),
});

export async function adminNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/notifications/policy', { preHandler: adminOnly }, async () => {
    return app.notificationPolicy.listPolicy();
  });

  app.put('/admin/notifications/policy', { preHandler: adminOnly }, async (request, reply) => {
    const body = patchSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: '请求参数无效' });
    const view = await app.notificationPolicy.updatePolicy(body.data as NotificationPolicyPatch);
    await writeAudit({
      action: 'notifications.policy.update',
      resource: 'notification.policy',
      meta: { types: Object.keys(body.data.types ?? {}) },
      ...auditContext(request),
    });
    return view;
  });
}
