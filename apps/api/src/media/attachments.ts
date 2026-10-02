/**
 * Attachment domain types (ADR-0014 §2).
 *
 * The `Attachment` row holds metadata only; the binary lives in object storage
 * under {@link buildMediaKey}. Persistence is expressed as a repository port so
 * the service stays free of Prisma and can be exercised with an in-memory fake —
 * and so the eventual kernel table (a KERNEL-owned migration) only has to
 * satisfy this interface.
 */
import { PluginError } from '@stackpanel/sdk';

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
  /** Apply a metadata patch (filename / visibility); returns the fresh row. */
  update(
    id: string,
    patch: { filename?: string | undefined; visibility?: AttachmentVisibility | undefined },
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
  /** Delete the row; callers remove the bytes separately. */
  delete(id: string): Promise<void>;
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
  variants: Array<{
    name: string;
    width: number;
    height: number;
    format: string;
    status: VariantStatus;
    url: string;
  }>;
  createdAt: string;
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
    variants: record.variants.map((variant) => ({
      name: variant.name,
      width: variant.width,
      height: variant.height,
      format: variant.format,
      status: variantStatus(variant),
      url: resolveUrl(variant.key),
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
