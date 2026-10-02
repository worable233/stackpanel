/**
 * Attachment object-key scheme (ADR-0014 §2).
 *
 * Binary blobs live in object storage; the `Attachment` row only holds metadata
 * and the `key`. Keys are deterministic from the row id so nothing has to be
 * stored twice, and they group the original and every generated variant of one
 * attachment under a single prefix (easy to delete, list and reason about).
 *
 * Layout: `media/<yyyy>/<mm>/<id>/<name>.<ext>`
 *   - `<name>` is `original` for the uploaded bytes, or the variant name.
 *   - date shards keep any single directory small on the local driver.
 */

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const SAFE_EXT = /^[a-z0-9]{1,10}$/;

/** Validate a variant/base name before it becomes an object-key segment. */
export function assertSafeMediaName(name: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`非法的媒体对象名：${name}`);
  }
}

export function assertSafeMediaExt(ext: string): void {
  if (!SAFE_EXT.test(ext)) {
    throw new Error(`非法的媒体扩展名：${ext}`);
  }
}

function dateParts(createdAt: Date): { year: string; month: string } {
  const year = String(createdAt.getUTCFullYear());
  const month = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  return { year, month };
}

/**
 * Key for the original bytes or one of its variants.
 *
 * @param id        Attachment cuid.
 * @param ext       Canonical extension WITHOUT the dot (from `sniffMime`).
 * @param createdAt Timestamp used for the date shard (defaults to now).
 * @param variant   Variant name; omit for the original.
 */
export function buildMediaKey(
  id: string,
  ext: string,
  createdAt: Date = new Date(),
  variant?: string,
): string {
  if (id.length === 0 || /[/\\]/.test(id)) throw new Error(`非法的附件 id：${id}`);
  assertSafeMediaExt(ext);
  const { year, month } = dateParts(createdAt);
  const name = variant ?? 'original';
  assertSafeMediaName(name);
  return `media/${year}/${month}/${id}/${name}.${ext}`;
}

/** Prefix shared by an attachment's original and all its variants. */
export function mediaPrefix(id: string, createdAt: Date = new Date()): string {
  const { year, month } = dateParts(createdAt);
  return `media/${year}/${month}/${id}/`;
}
