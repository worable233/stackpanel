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
  variantStatus,
  toAttachmentView,
  type AttachmentRecord,
  type AttachmentRepository,
  type AttachmentVariant,
  type AttachmentView,
  type AttachmentVisibility,
} from './attachments.ts';
import { buildMediaKey } from './keys.ts';
import { detectImageDimensions, sniffMime, type SniffedMime } from './mime.ts';
import { checkUpload, DEFAULT_MEDIA_POLICY, type MediaPolicy } from './policy.ts';
import {
  extensionForFormat,
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
  private readonly generateId: () => string;
  private readonly logger: { warn: (message: string) => void; info?: (message: string) => void };

  constructor(deps: AttachmentServiceDeps) {
    this.repository = deps.repository;
    this.storage = deps.storage;
    this.transform = deps.transform ?? unavailableImageTransformer;
    this.policy = deps.policy ?? DEFAULT_MEDIA_POLICY;
    this.queue = deps.queue;
    this.variantFormat = deps.variantFormat ?? 'webp';
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
    const key = buildMediaKey(id, type.ext, createdAt);
    await this.storage.put(key, input.data, { contentType: type.mime, public: false });

    const dims = type.kind === 'image' ? detectImageDimensions(input.data, type.mime) : null;

    // Stage B engages only for an eligible image with a live queue; everything
    // else (or async switched off) keeps the Stage A inline path.
    const asyncEligible =
      this.queue !== undefined && dims !== null && this.transform.supports(type.mime);
    const variants = asyncEligible
      ? planPendingVariants(id, createdAt, dims, this.variantFormat)
      : await this.generateVariants(input.data, type, id, createdAt, dims);

    const record = await this.repository.create({
      id,
      key,
      filename: sanitizeFilename(input.filename, type.ext),
      mime: type.mime,
      size: input.data.length,
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
    this.logger.info?.(`media: stored attachment ${id} (${type.mime}, ${input.data.length}B)`);
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

  /** Update display metadata (filename / visibility), owner or admin only. */
  async updateMetadata(
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
  ): Promise<{ data: Uint8Array; mime: string; record: AttachmentRecord } | null> {
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
    return { data, mime: target ? `image/${target.format}` : record.mime, record };
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
