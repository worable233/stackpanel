import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { extractSession, requireAuth } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { hashPassword, verifyPassword } from '../lib/password.ts';
import { getSessionStore } from '../auth/session-store.ts';
import { avatarContentUrl } from '../auth/avatar.ts';
import { rateLimitConfig } from '../lib/rate-limit-policy.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { sniffMime } from '../media/mime.ts';
import {
  attachmentReferences,
  buildMediaService,
  mediaActorFor,
  sendMediaError,
} from '../media/kernel-service.ts';

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(256),
});
const emailChangeSchema = z.object({
  currentPassword: z.string().min(1),
  email: z.string().email(),
});

/**
 * Avatars reuse the media domain, so the policy knobs here are only the deltas:
 * a picture (never a document/archive), and a ceiling an avatar has no business
 * crossing even though the media policy would allow 25MB.
 */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Raster formats only. SVG is an image by sniffing, but it is active content: the
 * content route deliberately serves it as a download, so it can never be an
 * avatar, and accepting it would only create a stored-XSS shaped footgun.
 */
const AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);/** Reference key under which a user's avatar attachment is registered. */
const AVATAR_REFERENCE = { resourceType: 'user', field: 'avatar' } as const;

/**
 * Platform auth surface. Login/register/logout live in the login plugin
 * (`/login`, `/register`, `/logout`) and call `ctx.auth`. The platform keeps
 * `/auth/identities` (bound third-party identities) and `/auth/session` (the
 * cheap session probe the web BFF and its proxy use) here; OAuth orchestration
 * stays in the kernel (it issues sessions).
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Avatar bodies are raw binary. Fastify content-type parsers are scoped to the
  // plugin that declares them, so the media routes' parsers do not reach this
  // scope and the avatar route has to bring its own (body limit = the avatar
  // ceiling, so an oversize body is refused before it is buffered).
  for (const contentType of AVATAR_MIMES) {
    app.addContentTypeParser(
      contentType,
      { bodyLimit: AVATAR_MAX_BYTES },
      (_request, payload, done) => {
        const chunks: Buffer[] = [];
        payload.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        payload.on('error', (err: Error) => done(err));
        payload.on('end', () => done(null, Buffer.concat(chunks)));
      },
    );
  }
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

  /**
   * Upload (or replace) the caller's avatar. Raw image body, like `POST /media`,
   * so the same per-content-type parser applies; the picture then goes through
   * the one media pipeline (sniffing, WebP delivery encode, variant ladder) and
   * is served from `/media/:id/content` like any other attachment.
   */
  app.post(
    '/auth/avatar',
    { preHandler: [requireAuth], ...rateLimitConfig('upload') },
    async (request, reply) => {
      const user = request.user;
      if (!user) return reply.code(401).send({ error: '未登录或会话已过期' });
      const body = request.body;
      const data =
        body instanceof Uint8Array
          ? body
          : Buffer.isBuffer(body)
            ? new Uint8Array(body)
            : null;
      if (!data || data.byteLength === 0) {
        return reply.code(400).send({ error: '缺少图片内容', code: 'media.no_content' });
      }
      if (data.byteLength > AVATAR_MAX_BYTES) {
        return reply.code(413).send({ error: '头像不能超过 5MB', code: 'media.too_large' });
      }
      const sniffed = sniffMime(data);
      if (!sniffed || !AVATAR_MIMES.has(sniffed.mime)) {
        return reply
          .code(415)
          .send({ error: '头像必须是 PNG / JPEG / GIF / WebP 图片', code: 'media.unsupported_type' });
      }
      const actor = mediaActorFor(user);
      const prisma = getPrisma();
      try {
        // Public on purpose: an avatar is what other people see next to a name.
        // The id is opaque and content-addressed only by revision, so widening
        // visibility exposes the picture the user chose to publish, nothing else.
        const attachment = await buildMediaService().ingest(
          { data, filename: `avatar.${sniffed.ext}`, visibility: 'public' },
          actor,
        );
        const references = attachmentReferences();
        // Register the reference before publishing the pointer, so the media
        // console reports this attachment as in-use and cannot orphan a live
        // avatar with a delete.
        await references.register({
          attachmentId: attachment.id,
          ...AVATAR_REFERENCE,
          resourceId: user.id,
        });
        const previous = await prisma.user.findUnique({
          where: { id: user.id },
          select: { avatarAttachmentId: true },
        });
        await prisma.user.update({
          where: { id: user.id },
          data: { avatarAttachmentId: attachment.id },
        });
        // Cleanup is best-effort: the new avatar is already live, so a failure
        // here must not turn the upload into an error the user cannot act on.
        if (previous?.avatarAttachmentId && previous.avatarAttachmentId !== attachment.id) {
          await references
            .unregister({
              attachmentId: previous.avatarAttachmentId,
              ...AVATAR_REFERENCE,
              resourceId: user.id,
            })
            .catch(() => undefined);
          await buildMediaService().remove(previous.avatarAttachmentId, actor).catch(() => undefined);
        }
        await writeAudit({
          action: 'user_update',
          resource: 'user',
          resourceId: user.id,
          meta: { field: 'avatar', attachmentId: attachment.id, mime: attachment.mime },
          ...auditContext(request),
        });
        return reply.code(201).send({
          avatarUrl: await avatarContentUrl(prisma, attachment.id),
        });
      } catch (err) {
        return sendMediaError(reply, err);
      }
    },
  );

  /** Drop the avatar; the pointers are cleared before the bytes are swept. */
  app.delete('/auth/avatar', { preHandler: [requireAuth] }, async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: '未登录或会话已过期' });
    const prisma = getPrisma();
    const current = await prisma.user.findUnique({
      where: { id: user.id },
      select: { avatarAttachmentId: true },
    });
    const attachmentId = current?.avatarAttachmentId;
    if (!attachmentId) return { avatarUrl: null };
    await prisma.user.update({ where: { id: user.id }, data: { avatarAttachmentId: null } });
    await attachmentReferences()
      .unregister({ attachmentId, ...AVATAR_REFERENCE, resourceId: user.id })
      .catch(() => undefined);
    await buildMediaService().remove(attachmentId, mediaActorFor(user)).catch(() => undefined);
    await writeAudit({
      action: 'user_update',
      resource: 'user',
      resourceId: user.id,
      meta: { field: 'avatar', attachmentId, cleared: true },
      ...auditContext(request),
    });
    return { avatarUrl: null };
  });
}
