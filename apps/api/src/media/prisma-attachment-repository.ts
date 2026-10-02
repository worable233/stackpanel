/**
 * Prisma-backed {@link AttachmentRepository} (kernel adapter).
 *
 * Uses raw SQL on purpose: the `attachments` table is a KERNEL-owned migration
 * that ships with the kernel wiring, and keeping the adapter off the generated
 * Prisma client means this module typechecks and builds before `prisma generate`
 * has seen the model. The SQL targets the schema documented in the MEDIA handoff
 * (see STATUS.md) and is parameterised throughout.
 *
 * The table may legitimately be absent (pre-migration); `findById` then returns
 * null and the upload route surfaces a clear 503 rather than crashing the
 * process, so a partial rollout degrades gracefully.
 */
import type { PrismaClient } from '@stackpanel/db';
import {
  type AttachmentRecord,
  type AttachmentRepository,
  type AttachmentVariant,
  type AttachmentVisibility,
  type CreateAttachmentInput,
} from './attachments.ts';

interface AttachmentRow {
  id: string;
  key: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  ownerId: string | null;
  visibility: string;
  variants: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function mapRow(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    key: row.key,
    filename: row.filename,
    mime: row.mime,
    size: Number(row.size),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    ownerId: row.ownerId,
    visibility: row.visibility === 'public' ? 'public' : 'private',
    variants: parseVariants(row.variants),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseVariants(value: unknown): AttachmentVariant[] {
  if (!Array.isArray(value)) return [];
  const out: AttachmentVariant[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const variant = entry as Record<string, unknown>;
    if (typeof variant.name !== 'string' || typeof variant.key !== 'string') continue;
    const status = variant.status;
    out.push({
      name: variant.name,
      key: variant.key,
      width: Number(variant.width ?? 0),
      height: Number(variant.height ?? 0),
      format: typeof variant.format === 'string' ? variant.format : 'webp',
      size: Number(variant.size ?? 0),
      ...(status === 'pending' || status === 'ready' || status === 'failed'
        ? { status }
        : {}),
      ...(typeof variant.attempts === 'number' ? { attempts: variant.attempts } : {}),
      ...(typeof variant.error === 'string' ? { error: variant.error } : {}),
    });
  }
  return out;
}

/** Prisma 7 surfaces a missing relation as P2021; a missing table also 42P01. */
function isMissingTable(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  const message = (err as { message?: string }).message ?? '';
  return code === 'P2021' || message.includes('does not exist') || message.includes('42P01');
}

export class PrismaAttachmentRepository implements AttachmentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateAttachmentInput): Promise<AttachmentRecord> {
    const rows = await this.prisma.$queryRaw<AttachmentRow[]>`
      INSERT INTO "attachments"
        ("id", "key", "filename", "mime", "size", "width", "height", "ownerId", "visibility", "variants", "updatedAt")
      VALUES (
        ${input.id}, ${input.key}, ${input.filename}, ${input.mime}, ${input.size},
        ${input.width ?? null}, ${input.height ?? null}, ${input.ownerId ?? null},
        ${input.visibility ?? 'private'}, ${JSON.stringify(input.variants ?? [])}::jsonb, CURRENT_TIMESTAMP
      )
      RETURNING *
    `;
    const row = rows[0];
    if (!row) throw new Error('media: 附件写入失败');
    return mapRow(row);
  }

  async findById(id: string): Promise<AttachmentRecord | null> {
    try {
      const rows = await this.prisma.$queryRaw<AttachmentRow[]>`
        SELECT * FROM "attachments" WHERE "id" = ${id} LIMIT 1
      `;
      return rows[0] ? mapRow(rows[0]) : null;
    } catch (err) {
      if (isMissingTable(err)) return null;
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    await this.prisma.$executeRaw`DELETE FROM "attachments" WHERE "id" = ${id}`;
  }

  async listByOwner(ownerId: string, limit = 100): Promise<AttachmentRecord[]> {
    try {
      const rows = await this.prisma.$queryRaw<AttachmentRow[]>`
        SELECT * FROM "attachments" WHERE "ownerId" = ${ownerId}
        ORDER BY "createdAt" DESC LIMIT ${Math.max(1, Math.min(limit, 200))}
      `;
      return rows.map(mapRow);
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }

  async update(
    id: string,
    patch: { filename?: string | undefined; visibility?: AttachmentVisibility | undefined },
  ): Promise<AttachmentRecord | null> {
    const rows = await this.prisma.$queryRaw<AttachmentRow[]>`
      UPDATE "attachments"
      SET "filename" = COALESCE(${patch.filename ?? null}, "filename"),
          "visibility" = COALESCE(${patch.visibility ?? null}, "visibility"),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}
      RETURNING *
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async updateVariants(id: string, variants: AttachmentVariant[]): Promise<AttachmentRecord | null> {
    const rows = await this.prisma.$queryRaw<AttachmentRow[]>`
      UPDATE "attachments"
      SET "variants" = ${JSON.stringify(variants)}::jsonb,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}
      RETURNING *
    `;
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async listPendingVariantAttachments(
    limit: number,
    maxAttempts: number,
  ): Promise<AttachmentRecord[]> {
    // A row qualifies while any variant is still pending and has not exhausted
    // its attempt budget. `jsonb_array_elements` scans the JSONB list in SQL so
    // the sweep stays a single indexed query, not a per-row client filter.
    const capped = Math.max(1, Math.min(limit, 500));
    try {
      const rows = await this.prisma.$queryRaw<AttachmentRow[]>`
        SELECT a.* FROM "attachments" a
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(a."variants") AS v
          WHERE v->>'status' = 'pending'
            AND COALESCE((v->>'attempts')::int, 0) < ${maxAttempts}
        )
        ORDER BY a."createdAt" ASC
        LIMIT ${capped}
      `;
      return rows.map(mapRow);
    } catch (err) {
      if (isMissingTable(err)) return [];
      throw err;
    }
  }
}

/** Whether an attachment's row can be reached (i.e. the table exists). */
export async function attachmentsTableReady(prisma: PrismaClient): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "attachments" LIMIT 1`;
    return true;
  } catch (err) {
    if (isMissingTable(err)) return false;
    throw err;
  }
}

export type { AttachmentVisibility };
