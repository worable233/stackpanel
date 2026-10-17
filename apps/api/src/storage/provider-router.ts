/**
 * Kernel storage router (ADR-0014 extension).
 *
 * Bridges a plugin-provided {@link StorageProvider} to the kernel's frozen
 * {@link StorageDriver} contract so media/brand/backup code never changes. The
 * router owns the byte channel: the provider only describes *where* bytes go
 * (`redirect` URL or `spool` path), and the router performs the transfer. That
 * keeps large objects off the isolated-plugin RPC channel.
 *
 * Reads fall back to the env-configured driver when the provider has no such
 * object, so switching to a provider never strands historical objects.
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { EXTENSION_POINTS } from '@stackpanel/sdk';
import type { StorageProvider } from '@stackpanel/sdk';
import {
  assertSafeStorageKey,
  type PutObjectOptions,
  type StorageDriver,
  type StorageObjectStat,
} from '@stackpanel/db';

/** Directory for one-time spool files handed to a provider. */
function spoolRoot(): string {
  return join(tmpdir(), 'stackpanel-spool');
}

export class KernelStorageRouter implements StorageDriver {
  readonly kind = 'provider' as const;

  constructor(
    private readonly provider: StorageProvider,
    private readonly fallback: StorageDriver,
  ) {}

  async put(key: string, data: Uint8Array, options: PutObjectOptions = {}): Promise<void> {
    assertSafeStorageKey(key);
    const target = await this.provider.beginPut({
      key,
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.public === undefined ? {} : { public: options.public }),
      size: data.length,
    });
    // An empty target means the provider is standing aside (e.g. configured to
    // 'env'); hand the write to the env driver.
    if (!target.uploadUrl && !target.spoolPath) {
      return this.fallback.put(key, data, options);
    }
    try {
      // The channel is inferred from what the provider returned, not from a
      // static declaration: a provider may switch backends at runtime.
      if (target.uploadUrl) {
        const response = await fetch(target.uploadUrl, {
          method: 'PUT',
          headers: {
            ...(options.contentType ? { 'content-type': options.contentType } : {}),
            ...(target.headers ?? {}),
          },
          body: data,
        });
        if (!response.ok) {
          throw new Error(`上传到存储 provider 失败：HTTP ${response.status}`);
        }
      } else {
        // A provider may hand us a destination path it owns (local disk: write
        // in place, zero copy) or ask us to spool to a temp file it will move.
        const providerOwnedPath = target.spoolPath;
        const spoolPath = providerOwnedPath ?? join(spoolRoot(), `${randomUUID()}.bin`);
        await mkdir(dirname(spoolPath), { recursive: true });
        await writeFile(spoolPath, data);
        await this.provider.confirmPut?.({ key, spoolPath });
        // Only clean up a temp file we created; a provider-owned path is the
        // object itself and must be left in place.
        if (!providerOwnedPath) await unlink(spoolPath).catch(() => undefined);
      }
      await this.provider.commitPut?.({ key });
    } catch (error) {
      await this.provider.abortPut?.({ key }).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertSafeStorageKey(key);
    const stat = await this.provider.stat(key).catch(() => null);
    // Provider does not have it: serve a historical object from the env driver.
    if (!stat) return this.fallback.get(key);
    const target = await this.provider.prepareGet(key);
    if ('url' in target) {
      const response = await fetch(target.url);
      if (!response.ok) return null;
      return new Uint8Array(await response.arrayBuffer());
    }
    // The provider owns the spool file on read (it may be the object itself),
    // so the router never deletes it here.
    const buffer = await readFile(target.spoolPath).catch(() => null);
    if (!buffer) return null;
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async delete(key: string): Promise<void> {
    assertSafeStorageKey(key);
    await this.provider.delete(key).catch(() => undefined);
    // Also clear a historical object from the env driver, best effort.
    await this.fallback.delete(key).catch(() => undefined);
  }

  async exists(key: string): Promise<boolean> {
    assertSafeStorageKey(key);
    if (await this.provider.exists(key).catch(() => false)) return true;
    return this.fallback.exists(key);
  }

  async stat(key: string): Promise<StorageObjectStat | null> {
    assertSafeStorageKey(key);
    const stat = await this.provider.stat(key).catch(() => null);
    if (stat) return stat;
    return this.fallback.stat(key);
  }

  async list(prefix = ''): Promise<StorageObjectStat[]> {
    const objects = await this.provider.list(prefix).catch(() => []);
    if (objects.length > 0) return objects;
    return this.fallback.list(prefix);
  }

  url(key: string): string {
    return this.provider.url(key);
  }

  /**
   * Signed read URL. A `redirect` provider already hands back a URL; a `spool`
   * provider cannot sign, so fall back to the API-served path (matching the
   * local driver's contract).
   */
  async signedUrl(key: string, expiresInSeconds?: number): Promise<string> {
    assertSafeStorageKey(key);
    try {
      const target = await this.provider.prepareGet(key, expiresInSeconds);
      if ('url' in target) return target.url;
    } catch {
      // fall through
    }
    return this.url(key);
  }

  /** Reachability probe for readiness checks (delegates to the provider). */
  async ping(): Promise<boolean> {
    if (this.provider.ping) return this.provider.ping();
    return true;
  }

  /**
   * One-time provisioning for the provider's backing store (e.g. create the S3
   * bucket if missing). The kernel calls this when the provider becomes the
   * active driver, so a freshly-configured backend is ready before first write.
   * Providers without a provisioning step are a no-op.
   */
  async ensureBucket(): Promise<void> {
    await this.provider.ensureReady?.();
  }
}

/** Read extension implementations from the plugin runtime. */
export interface StorageExtensionRuntime {
  getExtensions<T>(pointId: string): T[];
}

/**
 * Resolve the effective storage driver: the first `storage.provider`
 * implementation when present, otherwise the env-configured fallback. Mirrors
 * `resolveLlmProvider` (extension point → fallback), and never throws for the
 * "nothing configured" case.
 */
export function resolveStorageDriver(
  runtime: StorageExtensionRuntime,
  fallback: StorageDriver,
): StorageDriver {
  const provider = runtime.getExtensions<StorageProvider>(EXTENSION_POINTS.storageProvider)[0];
  if (!provider) return fallback;
  return new KernelStorageRouter(provider, fallback);
}
