/**
 * Storage provider contract (ADR-0014 extension).
 *
 * A plugin that implements {@link StorageProvider} and registers it on
 * `EXTENSION_POINTS.storageProvider` becomes the object-storage backend for the
 * whole installation (media, brand files, backups). The kernel consumes only
 * this contract; no plugin ever receives the kernel's raw `StorageDriver`.
 *
 * ## Control plane vs. byte plane
 *
 * This contract deliberately does **not** match the kernel's `StorageDriver`.
 * For `redirect`/`spool` a provider never receives a raw byte buffer: it only
 * returns a *description* of how the kernel should move the bytes, keeping large
 * objects off the isolated-plugin RPC channel (which caps a single message at
 * 1 MiB) so a third-party plugin can implement a real storage backend without
 * the kernel handling bytes through it. The `proxy` channel does pass bytes
 * through the provider, but in bounded chunks rather than one over-limit frame.
 *
 * Three byte channels are defined:
 *
 * - `redirect`: the provider returns a pre-signed PUT/GET URL (S3, R2, OSS,
 *   most image hosts). The kernel PUTs to the URL directly; nothing flows
 *   through the plugin. This is the zero-copy path and works for isolated
 *   plugins.
 * - `spool`: the kernel writes the bytes to a one-time file and hands the
 *   provider its absolute path (local disk, or a host that accepts a file
 *   path). Works for isolated plugins that share the host filesystem.
 * - `proxy`: the kernel streams the bytes to/from the provider in bounded
 *   chunks (`writeChunk`/`readChunk`). Needed for a custom HTTP image host
 *   that has no pre-signing and no shared filesystem (e.g. a multipart upload
 *   API). Each chunk is a separate control message, so a 25 MiB object never
 *   becomes a single over-limit RPC frame — this is what makes `proxy` safe
 *   over the 1 MiB isolated transport.
 */

/** How a provider moves object bytes. */
export type StorageByteMode = 'redirect' | 'spool' | 'proxy';

export interface StorageProviderObjectStat {
  key: string;
  size: number;
  /** ISO timestamp, when the provider can supply it. */
  lastModified?: string;
}

/** Where the kernel should send the bytes of a `beginPut`. */
export interface StoragePutTarget {
  /** `redirect`: the kernel PUTs the bytes to this URL. */
  uploadUrl?: string;
  /** Extra request headers the URL requires (e.g. pre-signed conditions). */
  headers?: Record<string, string>;
  /** `spool`: the kernel writes the bytes to this absolute path, then calls `confirmPut`. */
  spoolPath?: string;
  /**
   * `proxy`: the kernel streams the bytes back into the provider through
   * {@link StorageProvider.writeChunk}. Unlike `redirect`/`spool` there is no
   * handle to hand back — the provider itself is the byte sink.
   */
  proxy?: boolean;
}
export interface StorageBeginPutInput {
  key: string;
  contentType?: string;
  public?: boolean;
  size: number;
}

/** Where the kernel should read the bytes of a `prepareGet`. */
export type StorageGetTarget =
  | { url: string }
  | { spoolPath: string }
  /** `proxy`: the kernel pulls the bytes from the provider via {@link StorageProvider.readChunk}. */
  | { proxy: true };

/**
 * Byte budget for one `proxy` chunk. 256 KiB base64-encodes to ~342 KiB, safely
 * under the isolated transport's 1 MiB single-message cap (a 25 MiB object is
 * therefore ~100 bounded messages instead of one over-limit frame).
 */
export const STORAGE_PROXY_CHUNK_BYTES = 256 * 1024;

/** Arguments for one `proxy` write chunk. `offset` is the chunk's start. */
export interface StorageWriteChunkInput {
  key: string;
  /** Byte offset of this chunk within the object (0-based). */
  offset: number;
  /** Chunk payload (at most {@link STORAGE_PROXY_CHUNK_BYTES}). */
  data: Uint8Array;
  /** Total object size; present on every chunk so a stateless sink can preallocate. */
  size: number;
}

/** Arguments for one `proxy` read chunk. */
export interface StorageReadChunkInput {
  key: string;
  /** Byte offset to read from (0-based). */
  offset: number;
  /** Maximum number of bytes to return for this chunk. */
  length: number;
}

/**
 * A plugin-provided object-storage backend.
 *
 * `redirect`/`spool` methods are pure *control-plane* calls (no raw bytes); the
 * `proxy` channel adds bounded chunk calls (`writeChunk`/`readChunk`). The
 * kernel owns whichever byte channel the provider selects.
 */
export interface StorageProvider {
  /** Stable identifier used for logs and introspection. */
  readonly id: string;
  /** Human-readable name shown in the admin UI. */
  readonly name: string;
  /** The byte channel this provider uses. */
  readonly byteMode: StorageByteMode;

  /**
   * Begin a write. Returns where the kernel should put the bytes:
   * an upload URL (`redirect`), a spool path (`spool`), or `{ proxy: true }`
   * to have the kernel stream the bytes back into `writeChunk`.
   */
  beginPut(input: StorageBeginPutInput): Promise<StoragePutTarget>;
  /** `spool` only: the bytes are now at `spoolPath`; take ownership of them. */
  confirmPut?(input: { key: string; spoolPath: string }): Promise<void>;
  /**
   * `proxy` only: receive one chunk of the object being written. The kernel
   * calls this once per {@link STORAGE_PROXY_CHUNK_BYTES} in ascending offset
   * order, so a provider can append/upload incrementally and never holds the
   * whole object. Missing chunks are not an error for a stateless provider.
   */
  writeChunk?(input: StorageWriteChunkInput): Promise<void>;
  /** Called once after a successful write, for the provider to finalise. */
  commitPut?(input: { key: string }): Promise<void>;
  /** Called when a write fails, so the provider can roll back partial state. */
  abortPut?(input: { key: string }): Promise<void>;

  /**
   * Begin a read. Returns a `redirect` URL the kernel can follow (and 302 a
   * browser to), a `spoolPath` the provider has written the bytes to, or
   * `{ proxy: true }` to have the kernel pull the bytes via `readChunk`.
   */
  prepareGet(key: string, expiresInSeconds?: number): Promise<StorageGetTarget>;
  /**
   * `proxy` only: return the object bytes starting at `offset`, or `null` at
   * end of stream. Returning fewer than `length` bytes (including empty) signals
   * EOF to the kernel.
   */
  readChunk?(input: StorageReadChunkInput): Promise<Uint8Array | null>;

  /** Delete `key`. Missing objects are not an error. */
  delete(key: string): Promise<void>;
  /** Whether `key` currently exists. */
  exists(key: string): Promise<boolean>;
  /** Object metadata, or `null` when missing. */
  stat(key: string): Promise<StorageProviderObjectStat | null>;
  /** List keys under an optional `prefix`. */
  list(prefix?: string): Promise<StorageProviderObjectStat[]>;

  /** Public URL a browser can use to fetch a public object. */
  url(key: string): string;

  /**
   * Best-effort one-time provisioning for the backing store (e.g. create the
   * bucket if missing). The kernel calls this when the provider (re)becomes the
   * active storage backend, so a freshly-configured backend is ready before the
   * first write. Must be idempotent and safe to call on every activation.
   */
  ensureReady?(): Promise<void>;

  /** Reachability probe used by readiness checks. */
  ping?(): Promise<boolean>;
}

/**
 * A generic backend protocol a plugin can ask the kernel to build a
 * {@link StorageProvider} for. These are protocol/transport choices (local
 * filesystem, S3-compatible API, a plain HTTP image host), not vendors: the
 * kernel owns the byte/signing machinery so a plugin never imports kernel
 * packages or the AWS SDK.
 */
export type StorageBackendSpec =
  | { driver: 'local'; root: string; publicBaseUrl?: string }
  | {
      driver: 's3';
      endpoint?: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle?: boolean;
      publicBaseUrl?: string;
    }
  | {
      /**
       * A custom HTTP image host with no pre-signing. The kernel owns the byte
       * transfer through the `proxy` channel: it sends the object to `uploadUrl`
       * (raw `PUT`, or a multipart `POST` when `fieldName` is set) and reads it
       * back from `publicBaseUrl`/`{key}`. Credentials go in `headers`.
       */
      driver: 'http';
      /** Absolute URL that accepts the object bytes. */
      uploadUrl: string;
      /** Base URL a browser/`GET` can read objects from; object URL = `<base>/<key>`. */
      publicBaseUrl: string;
      /** `PUT` (default) sends the raw body; `POST` sends multipart/form-data. */
      method?: 'PUT' | 'POST';
      /** Multipart field name (only when `method` is `POST`). */
      fieldName?: string;
      /** Extra request headers (e.g. `Authorization`). */
      headers?: Record<string, string>;
      /** Optional URL template for deletes, with `{key}` placeholder. */
      deleteUrlTemplate?: string;
    };

/**
 * Kernel-owned storage capability (`ctx.storage`). A plugin builds a
 * {@link StorageProvider} for one of the generic backends and registers it on
 * `EXTENSION_POINTS.storageProvider`; the kernel keeps all byte-transfer and
 * credential-handling machinery on its side of the boundary.
 */
export interface StorageService {
  backend(spec: StorageBackendSpec): Promise<StorageProvider>;
}
