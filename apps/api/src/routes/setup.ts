import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { rateLimitConfig } from '../lib/rate-limit-policy.ts';
import { toPublicUser } from '../lib/user.ts';
import { headerUserAgent } from '../plugins/audit.ts';
import { getPrisma } from '../plugins/prisma.ts';
import {
  claimInstallation,
  setupStatus,
  SetupAlreadyCompletedError,
  SetupDisabledError,
  SetupTokenError,
} from '../auth/install-claim.ts';

/**
 * First-run setup wizard. Both routes are public by necessity (there is no
 * session yet), but they are safe by construction:
 *
 * - `GET /setup/status` is a read-only boolean probe with no side effects.
 * - `POST /setup` is the sole HTTP path that may mint the first administrator.
 *   It is rate-limited, token-gated when `STACKPANEL_SETUP_TOKEN` is configured,
 *   and serialized under the shared first-user advisory lock, so it can only
 *   ever run once and only when no admin exists. It 409s (not 403s) after the
 *   instance is claimed, so a completed instance never lingers as recon surface.
 */
export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/setup/status', async () => setupStatus());

  app.post(
    '/setup',
    { ...rateLimitConfig('setup') },
    async (request, reply) => {
      const body = z
        .object({
          email: z.string().email(),
          password: z.string().min(8),
          setupToken: z.string().min(1).max(256).optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.code(422).send({ error: '请求参数无效', code: 'validation.invalid' });
      }

      try {
        const userAgent = headerUserAgent(request);
        const { userId } = await claimInstallation({
          email: body.data.email,
          password: body.data.password,
          ...(body.data.setupToken ? { setupToken: body.data.setupToken } : {}),
          ip: request.ip,
          ...(userAgent ? { userAgent } : {}),
        });
        const token = await app.auth.issueSession(userId);
        const user = await getPrisma().user.findUniqueOrThrow({ where: { id: userId } });
        return reply.code(201).send({ token, user: toPublicUser(user) });
      } catch (error) {
        if (error instanceof SetupAlreadyCompletedError) {
          return reply.code(409).send({ error: error.message, code: 'setup.already_completed' });
        }
        if (error instanceof SetupDisabledError) {
          return reply.code(403).send({ error: error.message, code: 'setup.disabled' });
        }
        if (error instanceof SetupTokenError) {
          return reply.code(401).send({ error: error.message, code: 'setup.token_invalid' });
        }
        throw error;
      }
    },
  );
}
