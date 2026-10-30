/**
 * Attachment service (ADR-0014 §2–§4).
 *
 * Ties together the pieces: sniff the real type, enforce policy, decide the
 * variant plan, write bytes to object storage, and persist metadata through the
 * {@link AttachmentRepository} port. Persistence and byte storage are both
 * injected, so this service has no Prisma/global dependency and is fully
 * testable; the kernel wires the concrete implementations.
 *
 * Bytes are served by the API (`/media/:id/content`), not by a raw storage URL,
 * so access control is identical for the local and S3 drivers and a private
 * attachment is never exposed by guessing an object key.
 */
import type { StorageDriver } from '@stackpanel/db';
import { ContentDisposition } from './disposition.ts';
import {
  attachmentRevision,
  variantStatus,
  toAttachmentView,
  type AttachmentRecord,
  type AttachmentRepository,
  type AttachmentVariant,
  type AttachmentView,
  type AttachmentVisibility,
  type AttachmentLibraryQuery,
  type AttachmentLibraryStats,
} from './attachments.ts';
import { buildMediaKey } from './keys.ts';
import { detectImageDimensions, sniffMime, type SniffedMime } from './mime.ts';
import { checkUpload, DEFAULT_MEDIA_POLICY, type MediaPolicy } from './policy.ts';
import {
  extensionForFormat,
  optimizeTargetForMime,
  planImageVariants,
  unavailableImageTransformer,
  type ImageTransformer,
  type VariantSpec,
} from './image.ts';
import { planPendingVariants, type VariantJobPayload } from './variants.ts';

/** Who is asking. `canManage` means platform admin / attachment owner-manager. */
export interface MediaActor {
  userId?: string;
  canManage: boolean;
}

export interface IngestInput {
  data: Uint8Array;
  /** Browser-supplied filename, used for display and Content-Disposition only. */
  filename: string;
  /** Assign the attachment to a user; defaults to the actor. */
  ownerId?: string | null;
  visibility?: AttachmentVisibility;
}

/**
 * Enqueue seam for the async variant pipeline (ADR-0014 §4 Stage B). When
 * present, `ingest` records pending rows and hands encoding to the worker
 * instead of encoding inline; when absent (no job backend, or the async switch
 * is off) the service keeps the Stage A synchronous path.
 */
export interface VariantQueue {
  enqueue(payload: VariantJobPayload): Promise<void>;
}

export interface AttachmentServiceDeps {
  repository: AttachmentRepository;
  storage: StorageDriver;
  transform?: ImageTransformer;
  policy?: MediaPolicy;
  /** Async pipeline trigger; omit for the synchronous fallback. */
  queue?: VariantQueue;
  /** Encoded format for planned variants (Stage B). Defaults to `webp`. */
  variantFormat?: VariantSpec['format'];
  /**
   * Full-size WebP delivery encode (ADR-0014 §4 addendum). On by default: image
   * uploads are stored as WebP whenever that actually saves bytes.
   */
  optimize?: boolean;
  /** Id generator; defaults to a crypto cuid-like value. */
  generateId?: () => string;
  logger?: { warn: (message: string) => void; info?: (message: string) => void };
}

export class AttachmentService {
  private readonly repository: AttachmentRepository;
  private readonly storage: StorageDriver;
  private readonly transform: ImageTransformer;
  private readonly policy: MediaPolicy;
  private readonly queue: VariantQueue | undefined;
  private readonly variantFormat: VariantSpec['format'];
  private readonly optimize: boolean;
  private readonly generateId: () => string;
  private readonly logger: { warn: (message: string) => void; info?: (message: string) => void };

  constructor(deps: AttachmentServiceDeps) {
    this.repository = deps.repository;
    this.storage = deps.storage;
    this.transform = deps.transform ?? unavailableImageTransformer;
    this.policy = deps.policy ?? DEFAULT_MEDIA_POLICY;
    this.queue = deps.queue;
    this.variantFormat = deps.variantFormat ?? 'webp';
    this.optimize = deps.optimize ?? true;
    this.generateId = deps.generateId ?? defaultId;
    this.logger = deps.logger ?? { warn: (message) => console.warn(message) };
  }

  /** Store bytes, plan and best-effort generate image variants, persist metadata. */
  async ingest(input: IngestInput, actor: MediaActor): Promise<AttachmentView> {
    const sniffed = sniffMime(input.data);
    const rejection = checkUpload(sniffed, input.data.length, this.policy);
    if (rejection) {
      throw new MediaError(rejection.status, rejection.code, rejection.detail);
    }
    // checkUpload guarantees a non-null sniffed type from here on.
    const type = sniffed as SniffedMime;

    const id = this.generateId();
    const createdAt = new Date();
    // Full-size WebP delivery encode runs BEFORE the first write, so a rejected
    // source never lands in storage and there is exactly one copy of the bytes
    // (ADR-0014 §4 addendum: the WebP *is* the stored original from here on).
    const delivered = await this.deliverAsWebp(input.data, type);
    const stored: SniffedMime = delivered ? { ...type, mime: 'image/webp', ext: 'webp' } : type;
    const bytes = delivered?.bytes ?? input.data;
    const key = buildMediaKey(id, stored.ext, createdAt);
    await this.storage.put(key, bytes, { contentType: stored.mime, public: false });

    const dims = stored.kind === 'image' ? detectImageDimensions(bytes, stored.mime) : null;

    // Stage B engages only for an eligible image with a live queue; everything
    // else (or async switched off) keeps the Stage A inline path.
    const asyncEligible =
      this.queue !== undefined && dims !== null && this.transform.supports(stored.mime);
    const variants = asyncEligible
      ? planPendingVariants(id, createdAt, dims, this.variantFormat)
      : await this.generateVariants(bytes, stored, id, createdAt, dims);

    const record = await this.repository.create({
      id,
      key,
      filename: sanitizeFilename(
        delivered ? replaceExtension(input.filename, 'webp') : input.filename,
        stored.ext,
      ),
      mime: stored.mime,
      size: bytes.length,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      ownerId: input.ownerId !== undefined ? input.ownerId : (actor.userId ?? null),
      visibility: input.visibility ?? 'private',
      variants,
    });

    if (asyncEligible && variants.length > 0) {
      // Best-effort enqueue: if the queue rejects, the rows stay pending and the
      // recovery sweep picks them up — the upload still succeeds.
      await this.queue
        ?.enqueue({ attachmentId: id, format: this.variantFormat })
        .catch((err: unknown) =>
          this.logger.warn(`media: 变体入队失败，等待回填：${(err as Error).message}`),
        );
    }
    this.logger.info?.(`media: stored attachment ${id} (${stored.mime}, ${bytes.length}B)`);
    return this.toView(record);
  }

  /**
   * Best-effort variant generation. A failure — or an absent transformer — must
   * never fail the upload (ADR-0014 §4); it is logged and skipped.
   */
  private async generateVariants(
    data: Uint8Array,
    type: SniffedMime,
    id: string,
    createdAt: Date,
    dims: { width: number; height: number } | null,
  ): Promise<AttachmentVariant[]> {
    if (type.kind !== 'image' || !dims || !this.transform.supports(type.mime)) return [];
    const specs = planImageVariants(dims);
    const out: AttachmentVariant[] = [];
    for (const spec of specs) {
      try {
        const bytes = await this.transform.transform(data, type.mime, spec);
        if (!bytes) continue;
        const ext = extensionForFormat(spec.format);
        const variantKey = buildMediaKey(id, ext, createdAt, spec.name);
        await this.storage.put(variantKey, bytes, {
          contentType: `image/${spec.format}`,
          public: false,
        });
        out.push({
          name: spec.name,
          key: variantKey,
          width: spec.width,
          height: spec.height,
          format: spec.format,
          size: bytes.length,
        });
      } catch (err) {
        this.logger.warn(`media: variant ${spec.name} for ${id} failed: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /** Fetch metadata with authorization applied. */
  async get(id: string, actor: MediaActor): Promise<AttachmentView> {
    const record = await this.repository.findById(id);
    if (!record) throw new MediaError(404, 'media.not_found', '附件不存在');
    this.authorize(record, actor);
    return this.toView(record);
  }

  /**
   * List one owner's attachments. A non-admin may only list themselves; an
   * admin may list any owner (defaults to their own when no owner is given).
   */
  async list(actor: MediaActor, ownerId?: string, limit = 50): Promise<AttachmentView[]> {
    const target = ownerId ?? actor.userId;
    if (!target) throw new MediaError(403, 'media.forbidden', '无权访问附件');
    if (target !== actor.userId && !actor.canManage) {
      throw new MediaError(403, 'media.forbidden', '无权访问附件');
    }
    const records = await this.repository.listByOwner(target, limit);
    return records.map((record) => this.toView(record));
  }

  /**
   * Admin console: cross-owner filtered page. Authorization lives in the route
   * (`platform.admin`); this method is the query half so the media library page
   * does not have to paw through per-owner lists.
   */
  async library(query: AttachmentLibraryQuery): Promise<{
    items: AttachmentView[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const { items, total } = await this.repository.listForAdmin(query);
    return {
      items: items.map((record) => this.toView(record)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Admin console: aggregate counters (no per-row loading). */
  async libraryStats(): Promise<AttachmentLibraryStats> {
    return this.repository.stats();
  }

  /**
   * Admin repair: put every terminal `failed` variant back on the queue.
   *
   * `failed` is terminal by design (the recovery sweep only picks `pending`
   * rows), so an encoder outage strands affected thumbnails even after the
   * encoder starts working again. This is the explicit repair path; without a
   * queue the variants are re-encoded inline from the stored original.
   */
  async rebuildFailedVariants(
    attachmentId?: string,
  ): Promise<{ requeued: number; ids: string[] }> {
    const ids = await this.repository.resetFailedVariants(attachmentId);
    if (ids.length === 0) return { requeued: 0, ids: [] };

    if (this.queue) {
      for (const id of ids) {
        await this.queue
          .enqueue({ attachmentId: id, format: this.variantFormat })
          .catch((err: unknown) =>
            this.logger.warn(`media: 变体重建入队失败 ${id}：${(err as Error).message}`),
          );
      }
      return { requeued: ids.length, ids };
    }

    // No queue (async pipeline disabled): converge inline instead of leaving the
    // rows pending forever.
    for (const id of ids) {
      const record = await this.repository.findById(id);
      if (!record || record.variants.length === 0) continue;
      const data = await this.storage.get(record.key);
      if (!data) {
        this.logger.warn(`media: 重建变体时读不到原图 ${id}`);
        continue;
      }
      const type: SniffedMime = { mime: record.mime, ext: '', kind: 'image' };
      const dims =
        record.width !== null && record.height !== null
          ? { width: record.width, height: record.height }
          : null;
      const variants = await this.generateVariants(data, type, record.id, record.createdAt, dims);
      if (variants.length > 0) await this.repository.updateVariants(record.id, variants);
    }
    return { requeued: ids.length, ids };
  }

  /** Update display metadata (filename / visibility), owner or admin only. */  async updateMetadata(
    id: string,
    patch: { filename?: string | undefined; visibility?: AttachmentVisibility | undefined },
    actor: MediaActor,
  ): Promise<AttachmentView> {
    const record = await this.getRecord(id, actor);
    const updated = await this.repository.update(record.id, patch);
    if (!updated) throw new MediaError(404, 'media.not_found', '附件不存在');
    return this.toView(updated);
  }

  /** Metadata plus the record itself (for the content route). */
  async getRecord(id: string, actor: MediaActor): Promise<AttachmentRecord> {
    const record = await this.repository.findById(id);
    if (!record) throw new MediaError(404, 'media.not_found', '附件不存在');
    this.authorize(record, actor);
    return record;
  }

  /** Read variant bytes (or the original) plus the record, after authorization. */
  async readContent(
    id: string,
    actor: MediaActor,
    variantName?: string,
  ): Promise<{ data: Uint8Array; mime: string; record: AttachmentRecord; rev: string } | null> {
    const record = await this.getRecord(id, actor);
    const target = variantName
      ? record.variants.find((variant) => variant.name === variantName)
      : undefined;
    if (variantName && !target)
      throw new MediaError(404, 'media.variant_not_found', '图片变体不存在');
    // Async pipeline: the row exists but its bytes are not encoded yet.
    if (target && variantStatus(target) === 'pending') {
      throw new MediaError(409, 'media.variant_pending', '图片变体仍在生成中');
    }
    if (target && variantStatus(target) === 'failed') {
      throw new MediaError(404, 'media.variant_not_found', '图片变体生成失败');
    }
    const key = target ? target.key : record.key;
    const data = await this.storage.get(key);
    if (!data) return null;
    const mime = target ? `image/${target.format}` : record.mime;
    // The revision travels with the bytes so the HTTP layer can answer both
    // "is this link's copy current?" (ETag/304) and "may it be cached forever?"
    // (`?v=<rev>`) without a second storage read.
    const rev = target
      ? attachmentRevision({ key, size: target.size, mime })
      : attachmentRevision({ key, size: record.size, mime });
    return { data, mime, record, rev };
  }

  /** Delete an attachment and every stored object under its prefix. */
  async remove(
    id: string,
    actor: MediaActor,
    references?: { isReferenced(id: string): Promise<boolean> },
  ): Promise<void> {
    const record = await this.getRecord(id, actor);
    if (references && (await references.isReferenced(id))) {
      throw new MediaError(409, 'media.in_use', '附件仍被内容引用，无法删除');
    }
    // Delete metadata first. The attachment_references foreign key is the
    // final concurrency guard: a reference registered after the read above
    // makes this delete fail instead of allowing a dangling reference.
    try {
      await this.repository.delete(id);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const message = String(error instanceof Error ? error.message : error);
      if (code === '23503' || message.includes('attachment_references')) {
        throw new MediaError(409, 'media.in_use', '附件仍被内容引用，无法删除');
      }
      throw error;
    }
    // Object cleanup is deliberately after metadata deletion. A failed object
    // delete leaves an orphan blob that the media cleanup job can recover,
    // while no live database row can point at missing content.
    await this.storage.delete(record.key);
    for (const variant of record.variants) {
      await this.storage.delete(variant.key);
    }
  }

  /**
   * Full-size delivery encode (ADR-0014 §4 addendum).
   *
   * Returns null whenever the original is the better choice: not an image, an
   * SVG, no encoder wired, an encode failure — or when the WebP did not actually
   * get smaller. That last guard is what makes "convert everything" safe: a
   * lossless WebP of an already-lossy JPEG, or of a 3 KB icon, can be larger, and
   * trading bytes for identical pixels would be a net loss.
   */
  private async deliverAsWebp(
    data: Uint8Array,
    type: SniffedMime,
  ): Promise<{ bytes: Uint8Array; mime: string; ext: string } | null> {
    if (!this.optimize || type.kind !== 'image' || !this.transform.optimize) return null;
    const target = optimizeTargetForMime(type.mime);
    if (!target) return null;
    try {
      const encoded = await this.transform.optimize(data, type.mime, target);
      if (!encoded || encoded.length === 0 || encoded.length >= data.length) return null;
      return { bytes: encoded, mime: 'image/webp', ext: 'webp' };
    } catch (error) {
      this.logger.warn(`media: WebP 交付编码失败，保留原图：${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Re-encode stored attachments as WebP delivery files (media-library batch).
   *
   * Bounded on purpose: lossless WebP is the most CPU-expensive profile we run,
   * so one console click converts at most {@link OPTIMIZE_BATCH_LIMIT} rows and
   * the operator simply presses again. Rows that cannot improve (SVG, already
   * WebP, missing bytes, or an encode that came out larger) count as `skipped`,
   * so "nothing happened" always has a number behind it.
   */
  async optimizeLibrary(attachmentId?: string): Promise<{
    optimized: number;
    skipped: number;
    savedBytes: number;
    ids: string[];
  }> {
    const records = attachmentId
      ? [await this.repository.findById(attachmentId)]
      : await this.repository.listOptimizable(OPTIMIZE_BATCH_LIMIT);
    const ids: string[] = [];
    let skipped = 0;
    let savedBytes = 0;
    for (const record of records) {
      const converted = record ? await this.convertStored(record) : null;
      if (!record || !converted) {
        skipped += 1;
        continue;
      }
      ids.push(record.id);
      savedBytes += converted.savedBytes;
    }
    return { optimized: ids.length, skipped, savedBytes, ids };
  }

  /** One in-place conversion; null when the row cannot or should not change. */
  private async convertStored(record: AttachmentRecord): Promise<{ savedBytes: number } | null> {
    if (!this.optimize || !this.transform.optimize) return null;
    // Already WebP: re-encoding a lossy source losslessly only inflates it.
    if (record.mime === 'image/webp') return null;
    const target = optimizeTargetForMime(record.mime);
    if (!target) return null;
    const data = await this.storage.get(record.key);
    if (!data) return null;
    // Snapshot the old identity: the repository may hand back the very same row
    // object we are about to mutate, so reading `record.key` after `update()`
    // would point at the *new* object — and we would delete the bytes we just
    // wrote instead of the superseded ones.
    const previousKey = record.key;
    let encoded: Uint8Array | null;
    try {
      encoded = await this.transform.optimize(data, record.mime, target);
    } catch (error) {
      this.logger.warn(`media: WebP 转换失败 (${record.id})：${(error as Error).message}`);
      return null;
    }
    // Same guard as upload: never trade bytes for identical pixels.
    if (!encoded || encoded.length === 0 || encoded.length >= data.length) return null;
    const key = buildMediaKey(record.id, 'webp', record.createdAt);
    await this.storage.put(key, encoded, { contentType: 'image/webp', public: false });
    const updated = await this.repository.update(record.id, {
      key,
      mime: 'image/webp',
      size: encoded.length,
      filename: replaceExtension(record.filename, 'webp'),
    });
    if (!updated) {
      // The row was deleted while we were encoding: drop the bytes we just wrote
      // so no orphan object is left behind, and report a skip.
      await this.storage.delete(key);
      return null;
    }
    if (key !== previousKey) await this.storage.delete(previousKey);
    return { savedBytes: data.length - encoded.length };
  }

  /** Resolve the API content URL for a stored key; public and private alike. */
  contentUrl(id: string, variant?: string): string {
    const query = variant ? `?variant=${encodeURIComponent(variant)}` : '';
    return `/media/${id}/content${query}`;
  }

  private toView(record: AttachmentRecord): AttachmentView {
    return toAttachmentView(record, (key) => {
      const variant = record.variants.find((candidate) => candidate.key === key);
      return this.contentUrl(record.id, variant?.name);
    });
  }

  private authorize(record: AttachmentRecord, actor: MediaActor): void {
    if (record.visibility === 'public') return;
    if (actor.canManage) return;
    if (actor.userId && record.ownerId === actor.userId) return;
    throw new MediaError(403, 'media.forbidden', '无权访问该附件');
  }
}

/** RFC 6266 / 5987 safe filename for Content-Disposition. */
export function contentDisposition(filename: string, inline: boolean): string {
  return ContentDisposition.build(filename, inline);
}

/** Lossless WebP is CPU-heavy; bound one console click to this many rows. */
const OPTIMIZE_BATCH_LIMIT = 50;

/** Swap a filename's extension for display after a format change. */
export function replaceExtension(filename: string, ext: string): string {
  const trimmed = filename.trim();
  const dot = trimmed.lastIndexOf('.');
  return `${dot > 0 ? trimmed.slice(0, dot) : trimmed}.${ext}`;
}

/** Strip any path components and control characters; fall back to the type ext. */
export function sanitizeFilename(name: string, ext: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- control chars must not reach a header
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  if (cleaned.length === 0) return `file.${ext}`;
  return cleaned.length > 191 ? cleaned.slice(0, 191) : cleaned;
}

export class MediaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

function defaultId(): string {
  return `att_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}
