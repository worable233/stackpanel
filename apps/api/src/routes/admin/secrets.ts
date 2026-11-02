import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { encryptSecret, isSecretsEnabled } from '../../lib/crypto.ts';
import {
  SECRETS_DISABLED_CODE,
  SECRETS_DISABLED_MESSAGE,
  pluginsAffectedBySecret,
  secretsPolicy,
} from '../../lib/secrets-policy.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';
import { getRuntimeCoherence, publishRuntimeChange } from '../../runtime/coherence.ts';
import { env } from '../../config/env.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const setSecretSchema = z.object({
  value: z.string().min(1),
});

/**
 * Uniform 501 for every secret read/write when storage is disabled (H3): one
 * stable `code` (ADR-0012) so clients can distinguish "not configured" from a
 * genuine fault, instead of the previous bare `{ error }` shape.
 */
function secretsDisabled(reply: FastifyReply) {
  return reply.code(501).send({ code: SECRETS_DISABLED_CODE, error: SECRETS_DISABLED_MESSAGE });
}

export async function adminSecretsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/secrets', { preHandler: adminOnly }, async (_request, reply) => {
    const policy = secretsPolicy(env.SETTINGS_ENCRYPTION_KEY);
    if (!policy.enabled) {
      reply.header('Cache-Control', 'no-store');
      return { enabled: false, reason: policy.reason };
    }
    const prisma = getPrisma();
    const secrets = await prisma.secret.findMany({ orderBy: { key: 'asc' } });
    return {
      enabled: true,
      secrets: secrets.map((s) => ({ key: s.key, exists: true, updatedAt: s.updatedAt })),
    };
  });

  app.get('/admin/secrets/:key', { preHandler: adminOnly }, async (request, reply) => {
    if (!isSecretsEnabled()) {
      return secretsDisabled(reply);
    }
    const params = z.object({ key: z.string().min(1).max(191) }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: '请求参数无效' });
    }
    const prisma = getPrisma();
    const secret = await prisma.secret.findUnique({ where: { key: params.data.key } });
    return { key: params.data.key, exists: secret !== null };
  });

  app.put('/admin/secrets/:key', { preHandler: adminOnly }, async (request, reply) => {
    if (!isSecretsEnabled()) {
      return secretsDisabled(reply);
    }
    const params = z.object({ key: z.string().min(1).max(191) }).safeParse(request.params);
    const body = setSecretSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: '请求参数无效' });
    }
    const { key } = params.data;
    const ciphertext = encryptSecret(body.data.value);
    const prisma = getPrisma();
    await prisma.secret.upsert({
      where: { key },
      create: { key, ciphertext },
      update: { ciphertext },
    });
    await writeAudit({
      action: 'secret.set',
      resource: 'secret',
      resourceId: key,
      ...auditContext(request),
    });
    // 写库不等于生效：插件的 `ctx.secrets` 是激活时读一次的快照，只写库会让
    // 插件继续用旧值（支付插件表现为「已保存但一直报未配置」）。
    // 按 key 的命名空间定位受影响插件，再走幂等重载（重新 `onActivate` + 重建
    // 隔离 worker），并广播到其它副本。
    const reloaded = await reloadPluginsForSecret(request, key);
    return { key, exists: true, ...(reloaded.length ? { reloaded } : {}) };
  });
}

/**
 * 保存 secret 后让读到它的插件重新初始化。
 *
 * 重载是幂等的（`RuntimeCoherence.reload` 会先 unregister 再 register+activate），
 * 但**不能**因为它失败就把保存结果报成失败：secret 已经落库，运维重试一次保存
 * 反而是最直观的修复手段。所以失败只记日志，插件的 `state='failed'` 会经
 * `worker` 字段回到后台列表。
 */
async function reloadPluginsForSecret(
  request: { log: { warn: (obj: unknown, msg?: string) => void } },
  key: string,
): Promise<string[]> {
  const coherence = getRuntimeCoherence();
  if (!coherence) return [];
  const reloaded: string[] = [];
  for (const pluginId of pluginsAffectedBySecret(key)) {
    if (!coherence.runtime.has(pluginId)) continue;
    try {
      await coherence.reload(pluginId);
      reloaded.push(pluginId);
      // 本副本已经重载完毕；广播让其它副本也追上来（与 admin/plugins 的约定一致：
      // `publish` 只负责转告，本地的应用由调用方先做）。
      await publishRuntimeChange({ kind: 'plugin', id: pluginId, action: 'reload' });
    } catch (error) {
      request.log.warn(
        { pluginId, error: error instanceof Error ? error.message : String(error) },
        'secret saved but plugin reload failed',
      );
    }
  }
  return reloaded;
}
