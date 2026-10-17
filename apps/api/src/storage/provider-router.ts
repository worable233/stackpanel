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
import { EXTENSION_POINTS, STORAGE_PROXY_CHUNK_BYTES } from '@stackpanel/sdk';
import type { StorageProvider } from '@stackpanel/sdk';
import { isMetadataHostname } from '@stackpanel/net-guard';
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

/**
 * Reject a provider-supplied `redirect` URL pointed at a cloud-metadata service.
 *
 * The URL comes from plugin code (possibly a third-party isolated plugin), and
 * the *kernel* is what follows it — so an unguarded URL is an SSRF primitive: a
 * malicious provider could make the kernel GET/PUT to `169.254.169.254` and read
 * instance credentials. Consistent with the endpoint guard (`backend.ts`), this
 * blocks only link-local/metadata targets and non-http(s) schemes; private and
 * loopback hosts stay allowed because self-hosted MinIO commonly lives there.
 */
function assertSafeRedirect(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`存储 provider 返回了非法 URL：${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`存储 provider 返回了非 http(s) URL：${url.protocol}`);
  }
  if (isMetadataHostname(url.hostname)) {
    throw new Error(`存储 provider 返回了云元数据地址，已拒绝：${url.hostname}`);
  }
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
    if (!target.uploadUrl && !target.spoolPath && !target.proxy) {
      return this.fallback.put(key, data, options);
    }
    try {
      // The channel is inferred from what the provider returned, not from a
      // static declaration: a provider may switch backends at runtime.
      if (target.proxy) {
        await this.putProxy(key, data);
      } else if (target.uploadUrl) {
        assertSafeRedirect(target.uploadUrl);
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

  /**
   * `proxy` write: stream the object into the provider in bounded chunks. Each
   * chunk is one control call, so an object never becomes a single over-limit
   * message (the reason `proxy` is safe over the isolated transport).
   */
  private async putProxy(key: string, data: Uint8Array): Promise<void> {
    const writeChunk = this.provider.writeChunk;
    if (!writeChunk) {
      throw new Error('存储 provider 声明了 proxy 字节通道但未实现 writeChunk');
    }
    for (let offset = 0; offset < data.length; offset += STORAGE_PROXY_CHUNK_BYTES) {
      const end = Math.min(offset + STORAGE_PROXY_CHUNK_BYTES, data.length);
      await writeChunk.call(this.provider, {
        key,
        offset,
        data: data.subarray(offset, end),
        size: data.length,
      });
    }
    // Empty objects still need one call so the provider creates the key.
    if (data.length === 0) {
      await writeChunk.call(this.provider, { key, offset: 0, data: new Uint8Array(0), size: 0 });
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertSafeStorageKey(key);
    const stat = await this.provider.stat(key).catch(() => null);
    // Provider does not have it: serve a historical object from the env driver.
    if (!stat) return this.fallback.get(key);
    const target = await this.provider.prepareGet(key);
    if ('proxy' in target) {
      return this.getProxy(key, stat.size);
    }
    if ('url' in target) {
      assertSafeRedirect(target.url);
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

  /**
   * `proxy` read: pull the object from the provider in bounded chunks until it
   * returns fewer bytes than asked for (or `null`). Bounded per call for the
   * same reason as {@link putProxy}.
   */
  private async getProxy(key: string, size: number): Promise<Uint8Array | null> {
    const readChunk = this.provider.readChunk;
    if (!readChunk) {
      throw new Error('存储 provider 声明了 proxy 字节通道但未实现 readChunk');
    }
    const parts: Uint8Array[] = [];
    let offset = 0;
    // Bound the loop: prefer the stat size; fall back to a hard ceiling when the
    // provider reports no size, so a misbehaving provider cannot loop forever.
    const maxChunks = size > 0 ? Math.ceil(size / STORAGE_PROXY_CHUNK_BYTES) + 1 : 4096;
    for (let index = 0; index < maxChunks; index += 1) {
      const chunk = await readChunk.call(this.provider, {
        key,
        offset,
        length: STORAGE_PROXY_CHUNK_BYTES,
      });
      if (!chunk || chunk.byteLength === 0) break;
      parts.push(chunk);
      offset += chunk.byteLength;
      if (chunk.byteLength < STORAGE_PROXY_CHUNK_BYTES) break;
      if (size > 0 && offset >= size) break;
    }
    if (parts.length === 0 && size > 0) return null;
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
      out.set(part, cursor);
      cursor += part.byteLength;
    }
    return out;
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
      if ('url' in target) {
        assertSafeRedirect(target.url);
        return target.url;
      }
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
