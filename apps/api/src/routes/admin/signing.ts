import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getSigningStatus,
  isValidSigningPublicKey,
  setStoredSigningPublicKey,
} from '../../lib/signing-settings.ts';
import { auditContext, writeAudit } from '../../plugins/audit.ts';
import { requireAuth, requireRole } from '../../plugins/auth.ts';

const adminOnly = [requireAuth, requireRole('ADMIN')];

const setSigningKeySchema = z.object({
  publicKey: z.string().max(8192),
});

export async function adminSigningRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin/signing',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async () => {
      return { signing: await getSigningStatus() };
    },
  );

  app.patch(
    '/admin/signing',
    { preHandler: adminOnly, schema: { security: [{ bearerAuth: [] }] } },
    async (request, reply) => {
      const body = setSigningKeySchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: '公钥参数无效' });
      const publicKey = body.data.publicKey.trim();
      if (publicKey.length > 0 && !isValidSigningPublicKey(publicKey)) {
        return reply.code(422).send({ error: 'Ed25519 公钥无效' });
      }
      await setStoredSigningPublicKey(publicKey, request.user?.id ?? null);
      await writeAudit({
        action: publicKey ? 'signing.key.set' : 'signing.key.clear',
        resource: 'signing',
        ...auditContext(request),
      });
      return { signing: await getSigningStatus() };
    },
  );
}
