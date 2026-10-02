/**
 * Async variant pipeline domain (ADR-0014 §4 Stage B).
 *
 * Stage A encodes variants inline on the upload request thread; Stage B moves
 * that work onto the BullMQ worker (ADR-0013) so request latency is decoupled
 * from CPU, the work is retryable, and a variant lost to a crash is recovered by
 * a backfill sweep. The two stages share the same planner (`image.ts`), object
 * keys (`keys.ts`) and encoder (`sharp-transformer.ts`); only the trigger and the
 * point at which the row leaves `pending` differ.
 *
 * This module holds the pure, dependency-free part of Stage B: the job payload
 * shape and the "plan the pending rows" step. The byte-producing worker lives in
 * `worker.ts` so it can inject `StorageDriver` + `ImageTransformer` + repository.
 */
import type { AttachmentVariant } from './attachments.ts';
import { extensionForFormat, planImageVariants, type VariantSpec } from './image.ts';
import { buildMediaKey } from './keys.ts';
import type { ImageDimensions } from './mime.ts';

/** Max attempts before a stuck variant is marked `failed` (matches job retries). */
export const VARIANT_ATTEMPT_CAP = 3;

/** Fixed retry backoff handed to the queue for a variant job. */
export const VARIANT_JOB_BACKOFF_MS = 2_000;

/** Payload enqueued by the upload path and consumed by the variant worker. */
export interface VariantJobPayload {
  attachmentId: string;
  /** Format for every rung of this attachment (Stage B default: webp). */
  format: VariantSpec['format'];
}

/**
 * Plan the variant rows for an attachment and mark them `pending`. Empty when
 * the source is not an eligible image or is already small enough for every rung,
 * in which case no job is enqueued. Keys are deterministic from the id + date so
 * the worker needs nothing beyond the payload.
 */
export function planPendingVariants(
  id: string,
  createdAt: Date,
  dims: ImageDimensions,
  format: VariantSpec['format'] = 'webp',
): AttachmentVariant[] {
  return planImageVariants(dims, format).map((spec) => ({
    name: spec.name,
    key: buildMediaKey(id, extensionForFormat(spec.format), createdAt, spec.name),
    width: spec.width,
    height: spec.height,
    format: spec.format,
    size: 0,
    status: 'pending' as const,
    attempts: 0,
  }));
}
