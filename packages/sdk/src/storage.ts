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
 * A provider never receives a raw byte buffer: it only returns a *description*
 * of how the kernel should move the bytes. That keeps large objects off the
 * isolated-plugin RPC channel (which caps a single message at 1 MiB), so a
 * third-party plugin can implement a real storage backend without the kernel
 * handling bytes through it.
 *
 * Two byte channels are defined:
 *
 * - `redirect`: the provider returns a pre-signed PUT/GET URL (S3, R2, OSS,
 *   most image hosts). The kernel PUTs to the URL directly; nothing flows
 *   through the plugin. This is the zero-copy path and works for isolated
 *   plugins.
 * - `spool`: the kernel writes the bytes to a one-time file and hands the
 *   provider its absolute path (local disk, or a host that accepts a file
 *   path). Works for isolated plugins that share the host filesystem.
 *
 * A third mode, `proxy` (kernel streams bytes to/from the plugin), is reserved
 * for a future streaming-RPC primitive and is intentionally not part of this
 * version.
 */

/** How a provider moves object bytes. */
export type StorageByteMode = 'redirect' | 'spool';

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
}
export interface StorageBeginPutInput {
  key: string;
  contentType?: string;
  public?: boolean;
  size: number;
}

/** Where the kernel should read the bytes of a `prepareGet`. */
export type StorageGetTarget = { url: string } | { spoolPath: string };

/**
 * A plugin-provided object-storage backend.
 *
 * Every method is a *control-plane* call; none receives or returns raw object
 * bytes. The kernel owns the byte channel selected by {@link byteMode}.
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
   * an upload URL (`redirect`) or a spool path (`spool`).
   */
  beginPut(input: StorageBeginPutInput): Promise<StoragePutTarget>;
  /** `spool` only: the bytes are now at `spoolPath`; take ownership of them. */
  confirmPut?(input: { key: string; spoolPath: string }): Promise<void>;
  /** Called once after a successful write, for the provider to finalise. */
  commitPut?(input: { key: string }): Promise<void>;
  /** Called when a write fails, so the provider can roll back partial state. */
  abortPut?(input: { key: string }): Promise<void>;

  /**
   * Begin a read. Returns a `redirect` URL the kernel can follow (and 302 a
   * browser to), or a `spoolPath` the provider has written the bytes to.
   */
  prepareGet(key: string, expiresInSeconds?: number): Promise<StorageGetTarget>;

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
 * filesystem, S3-compatible API), not vendors: the kernel owns the byte/signing
 * machinery so a plugin never imports kernel packages or the AWS SDK.
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
