/**
 * Async image-variant worker (ADR-0014 §4 Stage B).
 *
 * Stage A generated variants inline during upload; this module is the worker
 * half that runs the same plan off the request thread under BullMQ (ADR-0013).
 * It is dependency-injected (repository + storage + transformer + lock) so it can
 * be exercised without Redis or a live DB, and it is deliberately idempotent:
 * keys are deterministic, so re-running a job overwrites the same bytes rather
 * than duplicating storage.
 *
 * Convergence is tracked on the attachment row itself, not on the queue: each
 * attempt increments the per-variant `attempts` counter, and a variant that
 * exhausts {@link VARIANT_ATTEMPT_CAP} is marked `failed` (terminal) instead of
 * being retried forever. `runVariantJob` therefore returns `retry` only while
 * something is still worth retrying, and the job handler throws exactly then so
 * BullMQ applies its own backoff. A slow recurring sweep re-enqueues rows left
 * `pending` by a crash, which is the at-least-once safety net.
 */
import type { StorageDriver } from '@stackpanel/db';
import {
  variantStatus,
  type AttachmentRepository,
  type AttachmentRecord,
  type AttachmentVariant,
} from './attachments.ts';
import type { ImageTransformer, VariantSpec } from './image.ts';
import { VARIANT_ATTEMPT_CAP, type VariantJobPayload } from './variants.ts';

export interface VariantWorkerDeps {
  repository: AttachmentRepository;
  storage: StorageDriver;
  transform: ImageTransformer;
  logger: { warn: (message: string) => void; info?: (message: string) => void };
  /**
   * Advisory per-attachment lock (shared across replicas when Redis-backed).
   * Serialises the upload-queued job and the backfill sweep so two encoders never
   * read-modify-write the same variant list. Absent -> run unserialised.
   */
  withLock?: (key: string, ttlMs: number, fn: () => Promise<void>) => Promise<boolean>;
  /** Attempt cap before a variant is marked failed. Defaults to the job cap. */
  maxAttempts?: number;
}

/** Outcome of one worker pass over a single attachment. */
export type VariantRunResult = 'done' | 'retry';

const LOCK_TTL_MS = 60_000;
const LOCK_PREFIX = 'media:variant:';

/** Encode every pending variant of one attachment; report whether to retry. */
export async function runVariantJob(
  deps: VariantWorkerDeps,
  payload: VariantJobPayload,
): Promise<VariantRunResult> {
  const id = payload.attachmentId;
  if (!id) return 'done';
  if (deps.withLock) {
    let inner: VariantRunResult = 'done';
    const ran = await deps.withLock(`${LOCK_PREFIX}${id}`, LOCK_TTL_MS, async () => {
      inner = await encodePending(deps, id);
    });
    // Lock contended: another worker owns this attachment right now. Leave the
    // row touched by nobody; the owning pass (or the sweep) finishes it.
    return ran ? inner : 'done';
  }
  return encodePending(deps, id);
}

async function encodePending(deps: VariantWorkerDeps, id: string): Promise<VariantRunResult> {
  const record = await deps.repository.findById(id);
  if (!record) return 'done'; // Deleted mid-flight; nothing to do.
  const cap = deps.maxAttempts ?? VARIANT_ATTEMPT_CAP;

  let original: Uint8Array | null = null;
  let touched = false;

  for (const variant of record.variants) {
    if (variantStatus(variant) !== 'pending') continue;
    touched = true;
    if (!deps.transform.supports(record.mime)) {
      markFailed(variant, `不支持的源类型：${record.mime}`);
      continue;
    }
    original ??= await deps.storage.get(record.key);
    if (!original) {
      bumpFailure(variant, cap, '原图字节缺失');
      continue;
    }
    const spec: VariantSpec = {
      name: variant.name,
      maxEdge: Math.max(variant.width, variant.height),
      width: variant.width,
      height: variant.height,
      // A legacy/foreign row may carry a non-encodable format; fall back to webp.
      format: isEncodableFormat(variant.format) ? variant.format : 'webp',
    };
    try {
      const bytes = await deps.transform.transform(original, record.mime, spec);
      if (!bytes) {
        bumpFailure(variant, cap, '编码未产出字节');
        continue;
      }
      await deps.storage.put(variant.key, bytes, {
        contentType: `image/${spec.format}`,
        public: false,
      });
      variant.size = bytes.length;
      variant.status = 'ready';
      variant.format = spec.format;
      delete variant.error;
    } catch (err) {
      bumpFailure(variant, cap, (err as Error).message);
    }
  }

  if (!touched) return 'done';

  const stillPending = record.variants.some(
    (variant) => variantStatus(variant) === 'pending' && (variant.attempts ?? 0) < cap,
  );
  await deps.repository.updateVariants(id, record.variants);
  const terminal = record.variants.filter((v) => variantStatus(v) === 'failed').length;
  if (terminal > 0) {
    deps.logger.warn(`media: ${terminal} 个变体在附件 ${id} 上标记失败`);
  }
  deps.logger.info?.(`media: 附件 ${id} 变体处理完成（待重试 ${stillPending ? '是' : '否'}）`);
  return stillPending ? 'retry' : 'done';
}

function isEncodableFormat(value: string): value is VariantSpec['format'] {
  return value === 'webp' || value === 'jpeg' || value === 'png';
}

/** Record a failed attempt; terminal once the cap is reached. */
function bumpFailure(variant: AttachmentVariant, cap: number, reason: string): void {
  const attempts = (variant.attempts ?? 0) + 1;
  variant.attempts = attempts;
  variant.error = reason;
  if (attempts >= cap) variant.status = 'failed';
}

/** Terminal failure with no further attempts (unsupported source type). */
function markFailed(variant: AttachmentVariant, reason: string): void {
  variant.attempts = Math.max(variant.attempts ?? 0, VARIANT_ATTEMPT_CAP);
  variant.error = reason;
  variant.status = 'failed';
}

/**
 * Backfill sweep: find attachments still carrying an in-budget `pending` variant
 * and run one worker pass over each. This recovers jobs lost to a crash between
 * the metadata write and the queue add. Returns how many attachments were swept.
 */
export async function processPendingVariants(
  deps: VariantWorkerDeps,
  limit = 50,
  format: VariantSpec['format'] = 'webp',
): Promise<number> {
  const cap = deps.maxAttempts ?? VARIANT_ATTEMPT_CAP;
  const rows = await deps.repository.listPendingVariantAttachments(limit, cap);
  for (const row of rows) {
    await runVariantJob(deps, { attachmentId: row.id, format });
  }
  return rows.length;
}

/** Test/repair helper: number of variants still `pending` on a record. */
export function countPending(record: AttachmentRecord): number {
  return record.variants.filter((variant) => variantStatus(variant) === 'pending').length;
}
