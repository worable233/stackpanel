import type { FastifyInstance } from 'fastify';
import { extractSession, requireAuth } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';

/**
 * Platform auth surface. Login/register/logout live in the login plugin
 * (`/login`, `/register`, `/logout`) and call `ctx.auth`. The platform keeps
 * `/auth/identities` (bound third-party identities) and `/auth/session` (the
 * cheap session probe the web BFF and its proxy use) here; OAuth orchestration
 * stays in the kernel (it issues sessions).
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Never 401s: the web proxy uses it as a first-line gate for /admin and the
  // server components use it to render the account shell. Migrates a legacy
  // JWT cookie into a server-side session (and re-issues the cookie) on the way.
  app.get('/auth/session', async (request, reply) => {
    const user = await extractSession(request, reply);
    if (!user) return { user: null };
    return {
      user: {
        id: user.id,
        role: user.permissions.has('platform.admin') ? 'ADMIN' : 'USER',
      },
    };
  });

  app.get('/auth/identities', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录或会话已过期' });
    const identities = await getPrisma().userIdentity.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, providerId: true, email: true, displayName: true, createdAt: true },
    });
    return { identities };
  });
}
