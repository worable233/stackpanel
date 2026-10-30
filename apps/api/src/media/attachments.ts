/**
 * Attachment domain types (ADR-0014 §2).
 *
 * The `Attachment` row holds metadata only; the binary lives in object storage
 * under {@link buildMediaKey}. Persistence is expressed as a repository port so
 * the service stays free of Prisma and can be exercised with an in-memory fake —
 * and so the eventual kernel table (a KERNEL-owned migration) only has to
 * satisfy this interface.
 */
import { createHash } from 'node:crypto';
import { PluginError } from '@stackpanel/sdk';
import type { MediaKind } from './mime.ts';

export type AttachmentVisibility = 'public' | 'private';

/**
 * Lifecycle of one variant (ADR-0014 §4 Stage B). The async pipeline records a
 * planned row as `pending` before the worker runs, then either stores the bytes
 * (`ready`) or gives up after the retry budget (`failed`). Rows created by the
 * synchronous Stage A path carry no status and are treated as `ready`.
 */
export type VariantStatus = 'pending' | 'ready' | 'failed';

/** One planned or generated derivative of an image attachment. */
export interface AttachmentVariant {
  /** Ladder segment, e.g. `thumb`. */
  name: string;
  /** Object key for the encoded bytes. */
  key: string;
  width: number;
  height: number;
  /** Encoded format, e.g. `webp`. */
  format: string;
  /** Encoded byte size; 0 until the async worker stores the bytes. */
  size: number;
  /** Lifecycle state; absent on legacy synchronous rows (see {@link variantStatus}). */
  status?: VariantStatus;
  /** Encoding attempts made so far (async path). */
  attempts?: number;
  /** Last failure detail when `status === 'failed'`. */
  error?: string;
}

/** Effective lifecycle state; a legacy row without an explicit status is ready. */
export function variantStatus(variant: AttachmentVariant): VariantStatus {
  return variant.status ?? 'ready';
}

export interface AttachmentRecord {
  id: string;
  key: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  ownerId: string | null;
  visibility: AttachmentVisibility;
  variants: AttachmentVariant[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAttachmentInput {
  id: string;
  key: string;
  filename: string;
  mime: string;
  size: number;
  width?: number | null;
  height?: number | null;
  ownerId?: string | null;
  visibility?: AttachmentVisibility;
  variants?: AttachmentVariant[];
}

/** Persistence port. The kernel Prisma adapter must satisfy this exact shape. */
export interface AttachmentRepository {
  create(input: CreateAttachmentInput): Promise<AttachmentRecord>;
  findById(id: string): Promise<AttachmentRecord | null>;
  /** Newest-first page of one owner's attachments (attachment picker). */
  listByOwner(ownerId: string, limit?: number): Promise<AttachmentRecord[]>;
  /**
   * Apply a metadata patch (filename / visibility / storage identity); returns
   * the fresh row. `key`/`mime`/`size` move together when the stored bytes are
   * re-encoded in place (WebP delivery encode, ADR-0014 §4 addendum).
   */
  update(
    id: string,
    patch: {
      filename?: string | undefined;
      visibility?: AttachmentVisibility | undefined;
      key?: string | undefined;
      mime?: string | undefined;
      size?: number | undefined;
    },
  ): Promise<AttachmentRecord | null>;
  /**
   * Replace the full `variants` list (async pipeline: pending -> ready/failed).
   * Returns the fresh row, or null when the attachment was deleted meanwhile.
   */
  updateVariants(id: string, variants: AttachmentVariant[]): Promise<AttachmentRecord | null>;
  /**
   * Oldest-first attachments that still have at least one `pending` variant under
   * the attempt cap. The async backfill sweep re-enqueues them so a variant job
   * lost to a crash is recovered (ADR-0014 §4).
   */
  listPendingVariantAttachments(limit: number, maxAttempts: number): Promise<AttachmentRecord[]>;
  /**
   * Oldest-first image attachments still stored in a convertible format
   * (PNG/JPEG/GIF), for the WebP backfill batch. Converted rows leave this set
   * because their `mime` becomes `image/webp`, so repeated runs converge.
   */
  listOptimizable(limit: number): Promise<AttachmentRecord[]>;
  /** Delete the row; callers remove the bytes separately. */
  delete(id: string): Promise<void>;
  /**
   * Cross-owner filtered page for the media library (admin console). Unlike
   * {@link listByOwner} this is not scoped to one owner and carries a total, so
   * the console can paginate without loading every row.
   */
  listForAdmin(query: AttachmentLibraryQuery): Promise<{
    items: AttachmentRecord[];
    total: number;
  }>;
  /** Aggregate counters for the media library header. */
  stats(): Promise<AttachmentLibraryStats>;
  /**
   * Reset every terminal `failed` variant back to `pending` (all rows, or one
   * attachment) and return the affected ids so the caller can re-enqueue them.
   * `failed` is terminal — without this repair an encoder outage strands the
   * thumbnails forever, even after the encoder is fixed.
   */
  resetFailedVariants(attachmentId?: string): Promise<string[]>;
}

/** Query shape for the media library list. */
export interface AttachmentLibraryQuery {
  page: number;
  pageSize: number;
  visibility?: AttachmentVisibility;
  /** Coarse kind derived from the stored MIME type (see `kindOfMime`). */
  kind?: MediaKind;
  /** Case-insensitive filename fragment. */
  q?: string;
  ownerId?: string;
}

/** Aggregate counters shown in the media library header. */
export interface AttachmentLibraryStats {
  total: number;
  bytes: number;
  byVisibility: { public: number; private: number };
  byKind: Record<MediaKind, number>;
  /** Variant lifecycle counters across every attachment. */
  variants: { pending: number; ready: number; failed: number };
}

/** Public API shape. URL is resolved at read time so it can be signed/short-lived. */
export interface AttachmentView {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  visibility: AttachmentVisibility;
  ownerId: string | null;
  url: string;
  /** Content revision of the stored original; see {@link attachmentRevision}. */
  rev: string;
  variants: Array<{
    name: string;
    width: number;
    height: number;
    format: string;
    status: VariantStatus;
    url: string;
    /** Content revision of this variant's bytes. */
    rev: string;
  }>;
  createdAt: string;
}

/**
 * Content revision of one stored object.
 *
 * Media URLs are deliberately identity-based (`/media/:id/content`, plus
 * `?variant=`), and the bytes behind them may change **in place** — an upload is
 * converted to WebP, a variant is re-encoded. That makes the URL a *mutable*
 * resource, so every link ever published keeps resolving (never a 404 after a
 * rewrite) while its content can move forward.
 *
 * The revision is what lets a client or a cache tell one version of those bytes
 * from the next without renaming the link:
 *
 * - old links (no `v`, or a stale `v`) keep working and revalidate cheaply;
 * - clients that want `immutable` caching append `?v=<rev>`;
 * - a `304 Not Modified` is decided from it without reading the object twice.
 *
 * Derived from the stored object's identity (`key` + `size` + `mime`) rather
 * than a hash of the bytes: those three fields are exactly what a rewrite
 * changes, they are already persisted, and deriving keeps this free of a schema
 * change or an extra storage read. It is published as a **weak** validator — a
 * conversion preserves the pixels, which is precisely what `W/` asserts.
 */
export function attachmentRevision(object: {
  key: string;
  size: number;
  mime: string;
}): string {
  return createHash('sha256')
    .update(`${object.key}\u0000${object.size}\u0000${object.mime}`)
    .digest('hex')
    .slice(0, 16);
}

export function toAttachmentView(
  record: AttachmentRecord,
  resolveUrl: (key: string) => string,
): AttachmentView {
  return {
    id: record.id,
    filename: record.filename,
    mime: record.mime,
    size: record.size,
    width: record.width,
    height: record.height,
    visibility: record.visibility,
    ownerId: record.ownerId,
    url: resolveUrl(record.key),
    rev: attachmentRevision(record),
    variants: record.variants.map((variant) => ({
      name: variant.name,
      width: variant.width,
      height: variant.height,
      format: variant.format,
      status: variantStatus(variant),
      url: resolveUrl(variant.key),
      rev: attachmentRevision({
        key: variant.key,
        size: variant.size,
        mime: `image/${variant.format}`,
      }),
    })),
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * Collect attachment ids referenced by a structured value (typically a
 * custom-resource `data` payload) under the given field name. Used to enforce
 * reference integrity before a delete: content that points at an attachment
 * must block that attachment's removal (ADR-0014 §2).
 */
export function collectAttachmentIds(value: unknown, field = 'attachments'): string[] {
  const ids = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (key === field && Array.isArray(child)) {
          for (const entry of child) {
            if (typeof entry === 'string' && entry.length > 0) ids.add(entry);
          }
        }
        visit(child);
      }
    }
  };
  visit(value);
  return [...ids];
}

/** Reference-integrity port: does any content still point at this id? */
export interface AttachmentReferences {
  isReferenced(id: string): Promise<boolean>;
}

/** Throw when any referenced attachment id no longer exists. */
export async function assertAttachmentsExist(
  repository: AttachmentRepository,
  ids: readonly string[],
): Promise<void> {
  const missing: string[] = [];
  for (const id of ids) {
    if (!(await repository.findById(id))) missing.push(id);
  }
  if (missing.length > 0) {
    throw new PluginError('media.reference_missing', 422, '引用的附件不存在', [
      { field: 'attachments', code: 'media.reference_missing', message: missing.join('、') },
    ]);
  }
}
