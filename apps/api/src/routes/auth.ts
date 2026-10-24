import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { extractSession, requireAuth } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { hashPassword, verifyPassword } from '../lib/password.ts';
import { getSessionStore } from '../auth/session-store.ts';

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(256),
});
const emailChangeSchema = z.object({
  currentPassword: z.string().min(1),
  email: z.string().email(),
});

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

  app.post('/auth/password', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = passwordChangeSchema.safeParse(request.body);
    if (!body.success || !request.user) return reply.code(400).send({ error: '请求参数无效' });
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (!user?.passwordHash || !(await verifyPassword(body.data.currentPassword, user.passwordHash))) {
      return reply.code(400).send({ error: '当前密码不正确' });
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.data.newPassword) },
    });
    await getSessionStore().revokeAll(user.id);
    return { ok: true as const };
  });

  app.post('/auth/email', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = emailChangeSchema.safeParse(request.body);
    if (!body.success || !request.user) return reply.code(400).send({ error: '请求参数无效' });
    const email = body.data.email.toLowerCase();
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (!user?.passwordHash || !(await verifyPassword(body.data.currentPassword, user.passwordHash))) {
      return reply.code(400).send({ error: '当前密码不正确' });
    }
    const exists = await prisma.user.findFirst({ where: { email, NOT: { id: user.id } } });
    if (exists) return reply.code(409).send({ error: '邮箱已被使用' });
    await prisma.user.update({
      where: { id: user.id },
      data: { email, emailVerifiedAt: null },
    });
    await getSessionStore().revokeAll(user.id);
    return { ok: true as const };
  });
}
