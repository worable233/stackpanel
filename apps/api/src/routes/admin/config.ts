/**
 * 运行期配置的后台接口（ADR-0026）。
 *
 * 后台改配置**必须**走这里，而不是通用的 `PUT /admin/settings/:key`：
 * 通用接口把 JSON 原样落库，写进一个运行期解析不了的值会一直静默失效；
 * 这里在写库前用 `envSchema` 同名字段校验，并在写入后广播失效消息，
 * 让所有副本（API + worker）在下一个请求就用上新值。
 *
 * 前端服务端执行准入不在这里：它由插件清单的 `frontendExecutions` 声明、
 * 安装时由内核裁决（`lib/plugins.ts` 拒绝非内置包自行声明 `server`），
 * 属于包的可信度问题而非运行期取值问题，见 ADR-0024。
 */
import type { FastifyInstance } from 'fastify';
import { PluginError } from '@stackpanel/sdk';
import { z } from 'zod';
import {
  isRuntimeConfigName,
  runtimeConfigEntries,
  saveRuntimeConfig,
} from '../../config/runtime-config.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { publishRuntimeChange } from '../../runtime/coherence.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];
const security = { security: [{ bearerAuth: [] }] };

const setValueSchema = z.object({
  /** `null` 表示删除数据库覆盖、回退到环境变量。 */
  value: z.json(),
});

const paramsSchema = z.object({ name: z.string().min(1).max(120) });

export async function adminConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/config', { preHandler: adminOnly, schema: security }, async () => ({
    entries: runtimeConfigEntries(),
  }));

  app.put<{ Params: { name: string } }>(
    '/admin/config/:name',
    { preHandler: adminOnly, schema: security },
    async (request) => {
      const params = paramsSchema.safeParse(request.params);
      const body = setValueSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        throw new PluginError('config.invalid_value', 400, '配置值无效');
      }
      const name = params.data.name;
      if (!isRuntimeConfigName(name)) {
        throw new PluginError('config.unknown_key', 404, '未知配置项');
      }
      try {
        await saveRuntimeConfig(name, body.data.value, request.user?.id ?? null);
      } catch (err) {
        throw new PluginError(
          'config.invalid_value',
          400,
          err instanceof Error ? err.message : '配置值无效',
        );
      }
      // 其它副本（API / worker）在下一个请求就用上新值，不需要重启。
      await publishRuntimeChange({ kind: 'config', id: '*', action: 'reload' });
      await writeAudit({
        action: body.data.value === null ? 'config.reverted' : 'config.changed',
        resource: `config:${name}`,
        ...auditContext(request),
      });
      return { entries: runtimeConfigEntries() };
    },
  );

  app.delete<{ Params: { name: string } }>(
    '/admin/config/:name',
    { preHandler: adminOnly, schema: security },
    async (request) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        throw new PluginError('config.invalid_value', 400, '配置值无效');
      }
      const name = params.data.name;
      if (!isRuntimeConfigName(name)) {
        throw new PluginError('config.unknown_key', 404, '未知配置项');
      }
      await saveRuntimeConfig(name, null, request.user?.id ?? null);
      await publishRuntimeChange({ kind: 'config', id: '*', action: 'reload' });
      await writeAudit({
        action: 'config.reverted',
        resource: `config:${name}`,
        ...auditContext(request),
      });
      return { entries: runtimeConfigEntries() };
    },
  );
}
