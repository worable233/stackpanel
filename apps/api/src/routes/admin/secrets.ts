import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { encryptSecret, isSecretsEnabled } from '../../lib/crypto.ts';
import {
  SECRETS_DISABLED_CODE,
  SECRETS_DISABLED_MESSAGE,
  secretsPolicy,
} from '../../lib/secrets-policy.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';
import { getPrisma } from '../../plugins/prisma.ts';
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
    return { key, exists: true };
  });
}
