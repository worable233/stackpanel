import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@stackpanel/db';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];
const reservedKeys = new Set([
  'platform.info',
  'signing.publicKey',
  'agent.conversationRetention',
  'agent.conversationCleanup',
  'distribution.catalogSource',
  'distribution.catalogPublicKey',
]);

const setSettingSchema = z.object({
  value: z.json(),
});

/** z.json() validates a JSON value; narrow it to Prisma's JSON input type. */
function toInputJson(value: z.infer<typeof setSettingSchema>['value']): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

export async function adminSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/settings', { preHandler: adminOnly }, async () => {
    const prisma = getPrisma();
    const settings = await prisma.setting.findMany({ orderBy: { key: 'asc' } });
    return {
      settings: settings.map((s) => ({ key: s.key, value: s.value, updatedAt: s.updatedAt })),
    };
  });

  app.put('/admin/settings/:key', { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ key: z.string().min(1).max(191) }).safeParse(request.params);
    const body = setSettingSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: '请求参数无效' });
    }
    const { key } = params.data;
    if (reservedKeys.has(key)) {
      return reply.code(403).send({ error: '该设置由专用接口管理' });
    }
    // 运行期配置（ADR-0026）走 `/admin/config`：那里用 `envSchema` 同名字段校验取值，
    // 并在写入后广播失效。通用接口原样落库，写进一个运行期解析不了的值会一直静默失效。
    if (key.startsWith('config.')) {
      return reply.code(403).send({ error: '该设置请通过「运行期配置」接口修改' });
    }
    const prisma = getPrisma();
    const setting = await prisma.setting.upsert({
      where: { key },
      create: { key, value: toInputJson(body.data.value), updatedBy: request.user?.id ?? null },
      update: { value: toInputJson(body.data.value), updatedBy: request.user?.id ?? null },
    });
    await writeAudit({
      action: 'setting.set',
      resource: 'setting',
      resourceId: key,
      ...auditContext(request),
    });
    return { key: setting.key, value: setting.value };
  });
}
