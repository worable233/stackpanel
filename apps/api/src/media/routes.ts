/**
 * Media/attachment HTTP surface (ADR-0014 §2–§4).
 *
 * Registered by the kernel with one line in `app.ts`
 * (`registerMediaRoutes(app)`), following the INTERFACES §6 convention.
 *
 * Uploads are raw binary bodies (`Content-Type: image/*` etc.) rather than
 * multipart: the kernel's global multipart parser caps every form at 2MB, which
 * is below the media policy. A per-route content-type parser buffers the bytes
 * up to the media ceiling instead, so the two limits never fight.
 *
 * Bytes are always served through `GET /media/:id/content` so authorization is
 * one code path for the local and S3 drivers, and a private object key is never
 * exposed.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { extractSession, requireAuth, type AuthUser } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { getStorage } from '../infra.ts';
import { rateLimitConfig } from '../lib/rate-limit-policy.ts';
import { env } from '../config/env.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { contentDisposition, MediaError } from './service.ts';
import { AttachmentService, type MediaActor, type VariantQueue } from './service.ts';
import { PrismaAttachmentRepository } from './prisma-attachment-repository.ts';
import { DEFAULT_MEDIA_POLICY } from './policy.ts';
import { createSharpTransformer } from './sharp-transformer.ts';
import { tryBuildVariantQueue } from './jobs.ts';
import type { AttachmentReferences, AttachmentVisibility } from './attachments.ts';

const uploadQuerySchema = z.object({
  filename: z.string().trim().min(1).max(191).optional(),
  visibility: z.enum(['public', 'private']).default('private'),
});

const listQuerySchema = z.object({
  ownerId: z.string().trim().min(1).max(191).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const patchSchema = z
  .object({
    filename: z.string().trim().min(1).max(191).optional(),
    visibility: z.enum(['public', 'private']).optional(),
  })
  .strict();

/** Content types we buffer for uploads; the real type is sniffed from bytes. */
const BINARY_CONTENT_TYPES = [
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
];

/** Env-tunable upload ceiling (ADR-0014 §3), defaulting to 25 MiB. */
function mediaMaxBytes(): number {
  return env.MEDIA_MAX_UPLOAD_BYTES;
}

function isAdmin(user: AuthUser): boolean {
  return user.permissions.has('platform.admin');
}

/**
 * Media types that can execute code when rendered inline. SVG is XML and may
 * carry `<script>`; HTML obviously so. These are always sent as downloads
 * (`Content-Disposition: attachment`) so the browser never executes them.
 */
function isActiveContent(mime: string): boolean {
  return mime === 'image/svg+xml' || mime === 'text/html' || mime === 'application/xhtml+xml';
}

function actorFor(user: AuthUser | undefined): MediaActor {
  return user ? { userId: user.id, canManage: isAdmin(user) } : { canManage: false };
}

function buildService(): AttachmentService {
  const queue = variantQueue();
  return new AttachmentService({
    repository: new PrismaAttachmentRepository(getPrisma()),
    storage: getStorage(),
    policy: { ...DEFAULT_MEDIA_POLICY, maxBytes: mediaMaxBytes() },
    transform: createSharpTransformer(),
    ...(queue ? { queue } : {}),
    logger: { warn: (m) => console.warn(m), info: (m) => console.info(m) },
  });
}

/**
 * The async variant trigger (ADR-0014 §4 Stage B). Present by default once a job
 * backend exists; `MEDIA_VARIANTS_ASYNC=false` forces the Stage A synchronous
 * path (rollback switch), and before `initInfra()` there is simply no queue, so
 * uploads still succeed on the inline path.
 */
function variantQueue(): VariantQueue | null {
  if (!env.MEDIA_VARIANTS_ASYNC) return null;
  return tryBuildVariantQueue();
}

/**
 * Reference-integrity port (ADR-0014 §2). Attachment references used to live in
 * the legacy `custom_resources` JSON payload; business-domain rows now live in
 * per-plugin `ext_*` tables whose shape the kernel must not know. There is
 * therefore no kernel-wide reference index to query, and deletion is unguarded
 * — plugins own their own referential integrity.
 */
function attachmentReferences(): AttachmentReferences {
  return { isReferenced: async () => false };
}

/** Actor for routes that may be anonymous (public attachment reads). */
async function optionalActor(request: FastifyRequest): Promise<MediaActor> {
  return actorFor((await extractSession(request)) ?? undefined);
}

function sendMediaError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof MediaError) {
    return reply.code(err.status).send({ error: err.message, code: err.code });
  }
  throw err;
}

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  const uploadLimit = mediaMaxBytes();
  for (const contentType of BINARY_CONTENT_TYPES) {
    app.addContentTypeParser(contentType, { bodyLimit: uploadLimit }, (_request, payload, done) => {
      const chunks: Buffer[] = [];
      payload.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      payload.on('error', (err: Error) => done(err));
      payload.on('end', () => done(null, Buffer.concat(chunks)));
    });
  }

  app.post(
    '/media',
    { preHandler: requireAuth, ...rateLimitConfig('upload') },
    async (request, reply) => {
      const query = uploadQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: '参数无效', code: 'validation.invalid' });
      }
      const body = request.body;
      const data =
        body instanceof Uint8Array ? body : Buffer.isBuffer(body) ? new Uint8Array(body) : null;
      if (!data) {
        return reply.code(400).send({ error: '缺少文件内容', code: 'media.no_content' });
      }
      const headerName = request.headers['x-filename'];
      const filename =
        query.data.filename ??
        (typeof headerName === 'string' && headerName.length > 0 ? headerName : 'upload');
      try {
        const attachment = await buildService().ingest(
          { data, filename, visibility: query.data.visibility as AttachmentVisibility },
          actorFor(request.user),
        );
        await writeAudit({
          action: 'media.upload',
          resource: 'attachment',
          resourceId: attachment.id,
          meta: { mime: attachment.mime, size: attachment.size },
          ...auditContext(request),
        });
        return reply.code(201).send({ attachment });
      } catch (err) {
        return sendMediaError(reply, err);
      }
    },
  );

  app.get('/media', { preHandler: requireAuth }, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: '参数无效', code: 'validation.invalid' });
    }
    try {
      const attachments = await buildService().list(
        actorFor(request.user),
        query.data.ownerId,
        query.data.limit,
      );
      return { attachments };
    } catch (err) {
      return sendMediaError(reply, err);
    }
  });

  app.get('/media/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return { attachment: await buildService().get(id, await optionalActor(request)) };
    } catch (err) {
      return sendMediaError(reply, err);
    }
  });

  app.get('/media/:id/content', async (request, reply) => {
    const { id } = request.params as { id: string };
    const variant = (request.query as { variant?: string }).variant;
    try {
      const result = await buildService().readContent(id, await optionalActor(request), variant);
      if (!result)
        return reply.code(404).send({ error: '附件内容不存在', code: 'media.not_found' });
      const { record } = result;
      const isInline = record.mime.startsWith('image/') || record.mime === 'application/pdf';
      // Active content (SVG is XML and can carry <script>) must never render
      // inline same-origin: the global CSP includes `script-src 'unsafe-inline'`,
      // so an uploaded SVG would become stored XSS. Forcing `attachment` makes
      // the browser download it instead of executing it. The global onSend hook
      // owns the CSP header, so this disposition is the effective control.
      const inline = isInline && !isActiveContent(record.mime);
      reply.header('Content-Type', result.mime);
      reply.header('Content-Disposition', contentDisposition(record.filename, inline));
      reply.header(
        'Cache-Control',
        record.visibility === 'public' ? 'public, max-age=86400' : 'private',
      );
      reply.header('X-Content-Type-Options', 'nosniff');
      return reply.send(Buffer.from(result.data));
    } catch (err) {
      return sendMediaError(reply, err);
    }
  });

  app.patch('/media/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = patchSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: '参数无效', code: 'validation.invalid' });
    try {
      const attachment = await buildService().updateMetadata(id, body.data, actorFor(request.user));
      await writeAudit({
        action: 'media.update',
        resource: 'attachment',
        resourceId: id,
        meta: { fields: Object.keys(body.data) },
        ...auditContext(request),
      });
      return { attachment };
    } catch (err) {
      return sendMediaError(reply, err);
    }
  });

  app.delete('/media/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await buildService().remove(id, actorFor(request.user), attachmentReferences());
      await writeAudit({
        action: 'media.delete',
        resource: 'attachment',
        resourceId: id,
        ...auditContext(request),
      });
      return { ok: true };
    } catch (err) {
      return sendMediaError(reply, err);
    }
  });
}
