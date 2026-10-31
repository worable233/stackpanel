/**
 * Kernel-side construction of the media service (ADR-0014 §2–§4).
 *
 * Both the attachment routes and the media-library admin routes need the exact
 * same wiring — same repository, storage driver, policy ceiling, image encoder
 * and variant queue. Keeping one factory here is what stops the admin surface
 * from drifting away from the upload path (a second, subtly different policy is
 * exactly how an upload limit turns into a support ticket).
 */
import type { FastifyReply } from 'fastify';
import { extractSession, type AuthUser } from '../plugins/auth.ts';
import { getPrisma } from '../plugins/prisma.ts';
import { getStorage } from '../infra.ts';
import { env } from '../config/env.ts';
import { getConfig } from '../config/runtime-config.ts';
import { AttachmentService, MediaError, type MediaActor, type VariantQueue } from './service.ts';
import { PrismaAttachmentRepository } from './prisma-attachment-repository.ts';
import { DEFAULT_MEDIA_POLICY } from './policy.ts';
import { createSharpTransformer } from './sharp-transformer.ts';
import { tryBuildVariantQueue } from './jobs.ts';
import { AttachmentReferenceService } from './references.ts';

/** Env-tunable upload ceiling (ADR-0014 §3), defaulting to 25 MiB. */
export function mediaMaxBytes(): number {
  return getConfig('MEDIA_MAX_UPLOAD_BYTES');
}

export function isMediaAdmin(user: AuthUser): boolean {
  return user.permissions.has('platform.admin');
}

export function mediaActorFor(user: AuthUser | undefined): MediaActor {
  return user ? { userId: user.id, canManage: isMediaAdmin(user) } : { canManage: false };
}

/**
 * The async variant trigger (ADR-0014 §4 Stage B). Present by default once a job
 * backend exists; `MEDIA_VARIANTS_ASYNC=false` forces the Stage A synchronous
 * path (rollback switch), and before `initInfra()` there is simply no queue, so
 * uploads still succeed on the inline path.
 */
export function mediaVariantQueue(): VariantQueue | null {
  if (!getConfig('MEDIA_VARIANTS_ASYNC')) return null;
  return tryBuildVariantQueue();
}

/**
 * Full-size WebP delivery encode (ADR-0014 §4 addendum). On by default;
 * `MEDIA_WEBP_OPTIMIZE=false` stores uploads with their original bytes (rollback
 * switch for a platform whose consumers still expect PNG/JPEG delivery).
 */
export function mediaWebpOptimize(): boolean {
  return env.MEDIA_WEBP_OPTIMIZE;
}

export function buildMediaService(): AttachmentService {
  const queue = mediaVariantQueue();
  return new AttachmentService({
    repository: new PrismaAttachmentRepository(getPrisma()),
    storage: getStorage(),
    policy: { ...DEFAULT_MEDIA_POLICY, maxBytes: mediaMaxBytes() },
    transform: createSharpTransformer(),
    optimize: mediaWebpOptimize(),
    ...(queue ? { queue } : {}),
    logger: { warn: (m) => console.warn(m), info: (m) => console.info(m) },
  });
}

/**
 * Reference-integrity port (ADR-0014 §2). Attachment references used to live in
 * the legacy `custom_resources` JSON payload; business-domain rows now live in
 * per-plugin `ext_*` tables whose shape the kernel must not know. Plugins use
 * the SDK media capability to maintain this kernel-owned reference index, so
 * deletion can enforce referential integrity without inspecting plugin tables.
 */
export function attachmentReferences(): AttachmentReferenceService {
  return new AttachmentReferenceService(getPrisma());
}

/** Actor for routes that may be anonymous (public attachment reads). */
export async function optionalMediaActor(
  request: Parameters<typeof extractSession>[0],
): Promise<MediaActor> {
  return mediaActorFor((await extractSession(request)) ?? undefined);
}

export function sendMediaError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof MediaError) {
    return reply.code(err.status).send({ error: err.message, code: err.code });
  }
  throw err;
}
