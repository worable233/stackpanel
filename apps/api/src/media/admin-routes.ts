/**
 * Media library admin surface (kernel side of the `media-library` plugin).
 *
 * Ownership split: the attachment domain is kernel-owned (ADR-0014 §2), so the
 * cross-owner queries an admin console needs — filtered listing, aggregate
 * counters, variant repair — live here. The `media-library` plugin owns only the
 * console UI and bridges its own routes to these endpoints with the caller's
 * session token, so the plugin can never read or mutate more than the calling
 * admin could (no privileged capability, no second authorization path).
 *
 * Every route here requires `platform.admin`. A mutation that changes an
 * attachment is still audited by the regular `/media/:id` routes the plugin
 * calls through; the repair action is audited here.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireRole } from '../plugins/auth.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { rateLimitConfig } from '../lib/rate-limit-policy.ts';
import { probeSharpEncoder } from './sharp-transformer.ts';
import { buildMediaService, sendMediaError } from './kernel-service.ts';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
  visibility: z.enum(['public', 'private']).optional(),
  kind: z.enum(['image', 'document', 'archive', 'video', 'audio', 'text', 'other']).optional(),
  q: z.string().trim().max(191).optional(),
  ownerId: z.string().trim().min(1).max(191).optional(),
});

const rebuildSchema = z
  .object({
    attachmentId: z.string().trim().min(1).max(191).optional(),
  })
  .strict();

export async function registerMediaAdminRoutes(app: FastifyInstance): Promise<void> {
  const adminOnly = { preHandler: [requireAuth, requireRole('ADMIN')] };

  /** Filtered, paginated cross-owner listing for the media library. */
  app.get('/media/admin/attachments', adminOnly, async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: '参数无效', code: 'validation.invalid' });
    }
    const { page, pageSize, visibility, kind, q, ownerId } = query.data;
    try {
      const result = await buildMediaService().library({
        page,
        pageSize,
        ...(visibility ? { visibility } : {}),
        ...(kind ? { kind } : {}),
        ...(q ? { q } : {}),
        ...(ownerId ? { ownerId } : {}),
      });
      return reply.send(result);
    } catch (err) {
      return sendMediaError(reply, err);
    }
  });

  /**
   * Aggregate counters + encoder health. The encoder probe is what turns a
   * silently failing image pipeline (every variant lands on `failed`) into
   * something an operator can see in one glance.
   */
  app.get('/media/admin/stats', adminOnly, async (_request, reply) => {
    try {
      const stats = await buildMediaService().libraryStats();
      const encoder = await probeSharpEncoder();
      return reply.send({ stats, encoder });
    } catch (err) {
      return sendMediaError(reply, err);
    }
  });

  /**
   * Re-queue failed variants. `failed` is terminal by design (the sweep only
   * picks `pending` rows), so after an encoder outage every affected attachment
   * needs an explicit repair — otherwise the thumbnails stay broken even after
   * the encoder is fixed.
   */
  app.post(
    '/media/admin/variants/rebuild',
    { preHandler: [requireAuth, requireRole('ADMIN')], ...rateLimitConfig('upload') },
    async (request, reply) => {
      const body = rebuildSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: '参数无效', code: 'validation.invalid' });
      }
      try {
        const result = await buildMediaService().rebuildFailedVariants(body.data.attachmentId);
        await writeAudit({
          action: 'media.variants.rebuild',
          resource: 'attachment',
          ...(body.data.attachmentId ? { resourceId: body.data.attachmentId } : {}),
          meta: { requeued: result.requeued },
          ...auditContext(request),
        });
        return reply.send(result);
      } catch (err) {
        return sendMediaError(reply, err);
      }
    },
  );
}
