/**
 * Avatars, stored as ordinary media attachments.
 *
 * Rationale (one image pipeline, one authorization path):
 * - the picture is ingested through the kernel media domain, so it gets the same
 *   sniffing, byte ceiling, WebP delivery encode, variant ladder and
 *   `GET /media/:id/content` authorization as every other image on the platform;
 * - `users.avatarAttachmentId` is a soft pointer: a deleted attachment leaves the
 *   column stale and the avatar just falls back to the account initial, which is
 *   why the column carries no foreign key.
 *
 * `avatarUrl` is derived, never stored: it must carry the content revision of the
 * bytes actually being served, so a re-upload (or a WebP conversion) changes the
 * URL and no cache can keep showing the previous face.
 */
import type { PrismaClient } from '@stackpanel/db';
import { attachmentRevision, type AttachmentVariant } from '../media/attachments.ts';

/** The rung an avatar wants: ≤256px, i.e. crisp at 2x on the largest UI slot. */
const AVATAR_VARIANT = 'thumb';

/** Exactly the columns the URL derivation needs (no bytes, no metadata). */
const AVATAR_COLUMNS = { key: true, size: true, mime: true, variants: true } as const;

/** Build the delivery URL from an already-loaded attachment row. */
function toAvatarUrl(attachmentId: string, attachment: AvatarRow): string {
  const variants = Array.isArray(attachment.variants)
    ? (attachment.variants as unknown as AttachmentVariant[])
    : [];
  // Prefer the small rung once the worker has produced it. A source image that
  // is already ≤256px has no `thumb` at all, and that is fine: the original is
  // then the cheapest thing we have.
  const thumb = variants.find(
    (variant) => variant.name === AVATAR_VARIANT && variant.status === 'ready' && variant.size > 0,
  );
  const rev = thumb
    ? attachmentRevision({ key: thumb.key, size: thumb.size, mime: `image/${thumb.format}` })
    : attachmentRevision(attachment);
  const params = new URLSearchParams();
  if (thumb) params.set('variant', AVATAR_VARIANT);
  // `v` is what makes the link cacheable forever: it is derived from the bytes,
  // so re-uploading an avatar publishes a different URL instead of relying on
  // caches noticing an unchanged path.
  params.set('v', rev);
  return `/media/${attachmentId}/content?${params.toString()}`;
}

interface AvatarRow {
  key: string;
  size: number;
  mime: string;
  variants: unknown;
}

/**
 * Resolve the delivery URL for an avatar attachment, or `null` when there is
 * nothing to show (no pointer, or a pointer whose attachment is already gone).
 */
export async function avatarContentUrl(
  db: PrismaClient,
  attachmentId: string | null | undefined,
): Promise<string | null> {
  if (!attachmentId) return null;
  const attachment = await db.attachment.findUnique({
    where: { id: attachmentId },
    select: AVATAR_COLUMNS,
  });
  return attachment ? toAvatarUrl(attachmentId, attachment) : null;
}

/**
 * Resolve many avatars in **one** query, keyed by attachment id.
 *
 * List surfaces (admin users, and anything else that renders a page of people)
 * must not turn into one attachment read per row, so they resolve the whole page
 * at once. Missing or forgotten rows simply have no entry; callers fall back to
 * the account initial.
 */
export async function avatarContentUrls(
  db: PrismaClient,
  attachmentIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [...new Set(attachmentIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const rows = await db.attachment.findMany({
    where: { id: { in: ids } },
    select: { id: true, ...AVATAR_COLUMNS },
  });
  return new Map(rows.map((row) => [row.id, toAvatarUrl(row.id, row)]));
}
