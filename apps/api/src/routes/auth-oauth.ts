import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import type { AuthIdentity, AuthProvider } from '@stackpanel/sdk';
import { z } from 'zod';
import { rateLimitConfig } from '../lib/rate-limit-policy.ts';
import { toPublicUser } from '../lib/user.ts';
import { isFirstUser } from '../auth/first-user.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { getStateService } from '../state/index.ts';

// H2: OAuth endpoints are public and credential-adjacent; the ceiling comes
// from the central rate-limit policy so all sensitive surfaces stay auditable.
const oauthLimit = rateLimitConfig('oauth');
const OAUTH_STATE_TTL_MS = 5 * 60_000;
const oauthStateKey = (state: string): string => `oauth:state:${state}`;

const callbackBodySchema = z.object({
  code: z.string().min(1),
  codeVerifier: z
    .string()
    .regex(/^[A-Za-z0-9._~-]{43,128}$/)
    .optional(),
  nonce: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/)
    .optional(),
  state: z.string().min(1),
});

const authorizeQuerySchema = z.object({
  codeChallenge: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43,128}$/)
    .optional(),
  nonce: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/)
    .optional(),
  state: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/)
    .optional(),
});

function providerList(app: FastifyInstance): AuthProvider[] {
  return app.pluginRuntime.getExtensions<AuthProvider>(EXTENSION_POINTS.authProvider);
}

function findProvider(app: FastifyInstance, id: string): AuthProvider | undefined {
  return providerList(app).find((p) => p.id === id);
}

/** Fallback email for providers that do not return one. */
function identityEmail(providerId: string, identity: AuthIdentity): string {
  if (identity.email) return identity.email.toLowerCase();
  return `${identity.externalId}@${providerId}.local`;
}

/**
 * OAuth third-party login. The kernel orchestrates the browser dance and owns
 * session issuance; providers registered at `auth.provider` only implement the
 * external exchange. BFF-style: the web client proxies these routes so the
 * session cookie is set on the web origin.
 */
export async function authOAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/oauth/providers', oauthLimit, async () => ({
    providers: providerList(app).map(({ id, name }) => ({ id, name })),
  }));

  app.get(
    '/auth/oauth/:providerId/authorize',
    oauthLimit,
    async (request, reply) => {
      const params = z.object({ providerId: z.string().min(1) }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: '请求参数无效' });
      const provider = findProvider(app, params.data.providerId);
      if (!provider) return reply.code(404).send({ error: '未知的认证服务' });
      const query = authorizeQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: '非法的授权请求' });
      const state = query.data.state ?? randomUUID();
      await getStateService().set(
        oauthStateKey(state),
        JSON.stringify({
          providerId: provider.id,
          nonce: query.data.nonce ?? null,
          createdAt: Date.now(),
        }),
        OAUTH_STATE_TTL_MS,
      );
      reply.setCookie('sp_oauth_state_api', state, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/auth/oauth',
        maxAge: 300,
      });
      const authorizeUrl = provider.authorizeUrl?.(state, {
        ...(query.data.codeChallenge ? { codeChallenge: query.data.codeChallenge } : {}),
        ...(query.data.nonce ? { nonce: query.data.nonce } : {}),
      });
      if (!authorizeUrl) {
        return reply.code(400).send({ error: '该认证服务不支持此回调方式' });
      }
      return { authorizeUrl, state };
    },
  );

  app.post(
    '/auth/oauth/:providerId/callback',
    oauthLimit,
    async (request, reply) => {
      const params = z.object({ providerId: z.string().min(1) }).safeParse(request.params);
      const body = callbackBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ error: '请求参数无效' });
      }
      const provider = findProvider(app, params.data.providerId);
      if (!provider) return reply.code(404).send({ error: '未知的认证服务' });

      const stateKey = oauthStateKey(body.data.state);
      if (request.cookies?.sp_oauth_state_api !== body.data.state) {
        return reply.code(401).send({ error: 'OAuth 浏览器状态不匹配' });
      }
      reply.clearCookie('sp_oauth_state_api', { path: '/auth/oauth' });
      // Consume the state atomically so concurrent callbacks cannot reuse it.
      const storedState = await getStateService().consume(stateKey);
      if (!storedState) return reply.code(401).send({ error: 'OAuth 状态已过期或无效' });
      try {
        const parsed = JSON.parse(storedState) as { providerId?: string; nonce?: string | null };
        if (parsed.providerId !== provider.id || (parsed.nonce && parsed.nonce !== body.data.nonce)) {
          return reply.code(401).send({ error: 'OAuth 状态校验失败' });
        }
      } catch {
        return reply.code(401).send({ error: 'OAuth 状态无效' });
      }

      const identity = await provider.authenticate({
        code: body.data.code,
        codeVerifier: body.data.codeVerifier,
        nonce: body.data.nonce,
        state: body.data.state,
      });
      if (!identity) {
        await writeAudit({
          action: 'auth.oauth.failed',
          resource: 'authProvider',
          resourceId: provider.id,
          meta: { externalId: undefined },
          ...auditContext(request),
        });
        return reply.code(401).send({ error: '认证失败' });
      }

      const prisma = getPrisma();
      const email = identityEmail(provider.id, identity);
      const existing = await prisma.userIdentity.findUnique({
        where: {
          providerId_externalId: { providerId: provider.id, externalId: identity.externalId },
        },
      });

      let userId: string;
      if (existing) {
        const user = await prisma.user.findUnique({ where: { id: existing.userId } });
        if (!user || user.status !== 'ACTIVE') {
          return reply.code(401).send({ error: '账号不可用' });
        }
        userId = user.id;
      } else {
        const taken = await prisma.user.findUnique({ where: { email } });
        if (taken) {
          await writeAudit({
            action: 'auth.oauth.conflict',
            resource: 'user',
            resourceId: taken.id,
            meta: { providerId: provider.id, externalId: identity.externalId },
            ...auditContext(request),
          });
          return reply.code(409).send({ error: '该邮箱已在本平台注册' });
        }
        const created = await prisma.$transaction(async (tx) => {
          // Serialize the first-admin election against concurrent sign-ups
          // (SECURITY-AUDIT-2026-10-04 L-4).
          const isFirst = await isFirstUser(tx);
          const user = await tx.user.create({
            data: {
              email,
              passwordHash: null,
              status: 'ACTIVE',
              groups: {
                create: { groupId: isFirst ? 'group_admin' : 'group_user' },
              },
              identities: {
                create: {
                  providerId: provider.id,
                  externalId: identity.externalId,
                  ...(identity.email ? { email: identity.email.toLowerCase() } : {}),
                  ...(identity.displayName ? { displayName: identity.displayName } : {}),
                },
              },
            },
          });
          return user;
        });
        userId = created.id;
      }

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const token = await app.auth.issueSession(user.id);
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await writeAudit({
        action: 'auth.oauth.login',
        resource: 'user',
        resourceId: user.id,
        meta: { providerId: provider.id, externalId: identity.externalId },
        ...auditContext(request),
      });
      return { token, user: toPublicUser(user) };
    },
  );
}
