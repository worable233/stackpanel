/**
 * Media module barrel. The kernel imports `registerMediaRoutes` from here and
 * appends one line to `app.ts` (INTERFACES §6).
 */
export { registerMediaRoutes } from './routes.ts';
export { AttachmentService, MediaError, contentDisposition, sanitizeFilename } from './service.ts';
export type {
  AttachmentServiceDeps,
  IngestInput,
  MediaActor,
  VariantQueue,
} from './service.ts';
export {
  assertAttachmentsExist,
  collectAttachmentIds,
  toAttachmentView,
  variantStatus,
  type AttachmentRecord,
  type AttachmentRepository,
  type AttachmentReferences,
  type AttachmentVariant,
  type AttachmentView,
  type AttachmentVisibility,
  type VariantStatus,
} from './attachments.ts';
export {
  PrismaAttachmentRepository,
  attachmentsTableReady,
} from './prisma-attachment-repository.ts';
export {
  sniffMime,
  detectImageDimensions,
  isProbablyText,
  type SniffedMime,
  type MediaKind,
} from './mime.ts';
export {
  checkUpload,
  DEFAULT_MEDIA_POLICY,
  type MediaPolicy,
  type UploadRejection,
} from './policy.ts';
export {
  IMAGE_VARIANTS,
  extensionForFormat,
  fitWithin,
  planImageVariants,
  unavailableImageTransformer,
  type ImageTransformer,
  type VariantSpec,
} from './image.ts';
export { buildMediaKey, mediaPrefix } from './keys.ts';
export { sanitizeRichText, isSafeUrl, type SanitizeOptions } from './sanitize.ts';
export {
  VARIANT_ATTEMPT_CAP,
  VARIANT_JOB_BACKOFF_MS,
  planPendingVariants,
  type VariantJobPayload,
} from './variants.ts';
export {
  countPending,
  processPendingVariants,
  runVariantJob,
  type VariantRunResult,
  type VariantWorkerDeps,
} from './worker.ts';
export {
  MEDIA_BACKFILL_MS,
  MEDIA_JOBS,
  VARIANT_JOB_OPTIONS,
  buildVariantWorkerDeps,
  registerMediaJobs,
  tryBuildVariantQueue,
} from './jobs.ts';
