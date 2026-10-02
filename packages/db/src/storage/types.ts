/**
 * Object storage abstraction (ADR-0014 / ADR-0017 §8).
 *
 * One interface, two drivers: an S3-compatible driver (MinIO / R2 / OSS / AWS)
 * for production and a local-disk driver for development. Application code and
 * plugins only ever see {@link StorageDriver}, so switching between them never
 * branches at the call site.
 *
 * Keys are slash-separated, provider-agnostic object paths (e.g.
 * `brand/logo.png`). Drivers own how a key maps to bytes and to a URL.
 */

export interface StorageObjectStat {
  key: string;
  size: number;
  /** ISO timestamp, when the driver can provide it. */
  lastModified?: string;
}

export interface PutObjectOptions {
  contentType?: string;
  /** When false the driver stores non-public objects (S3 ACL / server-side). */
  public?: boolean;
}

export interface StorageDriver {
  /** Stable identifier used for logs and introspection. */
  readonly kind: 'local' | 's3';
  /** Write bytes at `key`, overwriting any existing object. */
  put(key: string, data: Uint8Array, options?: PutObjectOptions): Promise<void>;
  /** Read bytes at `key`, or null when the object does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Delete `key`. Missing objects are not an error. */
  delete(key: string): Promise<void>;
  /** Whether `key` currently exists. */
  exists(key: string): Promise<boolean>;
  /** Object metadata, or null when missing. */
  stat(key: string): Promise<StorageObjectStat | null>;
  /** List keys under an optional `prefix`. */
  list(prefix?: string): Promise<StorageObjectStat[]>;
  /**
   * Public URL a browser can use to fetch `key`.
   *
   * Local driver returns a path served by the API; S3 returns a direct object
   * URL. Drivers that need signed URLs may return one here.
   */
  url(key: string): string;
  /**
   * Time-limited URL for reading a non-public object (ADR-0014 §2).
   *
   * Append-only addition to the frozen interface: drivers that can mint signed
   * URLs implement this; callers treat it as optional and fall back to
   * {@link url}. The local driver returns the same API-served path (the API
   * proxies the bytes, so there is no secret to sign in development); the S3
   * driver returns a presigned GET URL.
   */
  signedUrl?(key: string, expiresInSeconds?: number): Promise<string>;
}

/** Reject keys that could escape the storage root or address another bucket. */
export function assertSafeStorageKey(key: string): void {
  if (key.length === 0) throw new Error('storage key 不能为空');
  if (key.startsWith('/') || key.includes('\\')) {
    throw new Error(`非法的 storage key：${key}`);
  }
  const segments = key.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`非法的 storage key：${key}`);
  }
}

/** Guess a content type from a key's extension (drivers/HTTP fallback). */
export function contentTypeForKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'js':
    case 'mjs':
      return 'text/javascript; charset=utf-8';
    case 'css':
      return 'text/css; charset=utf-8';
    case 'txt':
      return 'text/plain; charset=utf-8';
    case 'html':
      return 'text/html; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
