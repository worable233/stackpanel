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
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.ts';
import { rateLimitConfig } from '../lib/rate-limit-policy.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { contentDisposition } from './service.ts';
import { isActiveContent } from './disposition.ts';
import type { AttachmentVisibility } from './attachments.ts';
import {
  attachmentReferences,
  buildMediaService as buildService,
  mediaActorFor as actorFor,
  mediaMaxBytes,
  optionalMediaActor as optionalActor,
  sendMediaError,
} from './kernel-service.ts';
import { registerMediaAdminRoutes } from './admin-routes.ts';

/**
 * Match an `If-None-Match` header against the etag we would send.
 *
 * The header is a comma-separated list of validators (or `*`), and a client may
 * echo our weak validator verbatim or strip the `W/` prefix — both must count as
 * a match, otherwise a revalidation silently re-sends a multi-megabyte body.
 */
function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const weak = etag.replace(/^W\//, '');
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw.split(',').some((value) => {
    const candidate = value.trim();
    return candidate === '*' || candidate === etag || candidate.replace(/^W\//, '') === weak;
  });
}

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

  app.get('/media/:id/references', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user || !actorFor(request.user).canManage) {
      return reply.code(403).send({ error: '无权查看附件引用', code: 'media.forbidden' });
    }
    const { id } = request.params as { id: string };
    try {
      await buildService().getRecord(id, actorFor(request.user));
      const references = await attachmentReferences().list(id);
      return { references };
    } catch (err) {
      return sendMediaError(reply, err);
    }
  });

  app.get('/media/:id/content', { ...rateLimitConfig('publicRead') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const variant = (request.query as { variant?: string }).variant;
    try {
      const result = await buildService().readContent(id, await optionalActor(request), variant);
      if (!result)
        return reply.code(404).send({ error: '附件内容不存在', code: 'media.not_found' });
      const { record, rev } = result;
      const isInline = record.mime.startsWith('image/') || record.mime === 'application/pdf';
      // Active content (SVG is XML and can carry <script>) must never render
      // inline same-origin: the global CSP includes `script-src 'unsafe-inline'`,
      // so an uploaded SVG would become stored XSS. Forcing `attachment` makes
      // the browser download it instead of executing it. The global onSend hook
      // owns the CSP header, so this disposition is the effective control.
      const inline = isInline && !isActiveContent(record.mime);
      // Same link, moving bytes: `/media/:id/content` is stable on purpose — every
      // URL already published keeps resolving after a conversion — so how long a
      // copy may be cached has to be decided by the content revision, not the path.
      //
      // `?v=<rev>` (what the API hands out to clients that opt in) is immutable;
      // anything else — a link written before the conversion, or with an outdated
      // `v` — revalidates every time, so an old link is corrected on its next view
      // instead of showing pre-conversion bytes for a day.
      const etag = `W/"${rev}"`;
      const versioned = (request.query as { v?: string }).v === rev;
      reply.header('ETag', etag);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header(
        'Cache-Control',
        record.visibility !== 'public'
          ? 'private, max-age=0, must-revalidate'
          : versioned
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=0, must-revalidate',
      );
      if (matchesEtag(request.headers['if-none-match'], etag)) {
        return reply.code(304).send();
      }
      reply.header('Content-Type', result.mime);
      reply.header('Content-Disposition', contentDisposition(record.filename, inline));
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

  // Cross-owner listing, aggregate counters and variant repair for the
  // media-library console. Requires `platform.admin` on every route.
  await registerMediaAdminRoutes(app);
}
