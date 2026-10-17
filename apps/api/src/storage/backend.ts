/**
 * Kernel storage capability (`ctx.storage`).
 *
 * A plugin describes a *generic backend protocol* (local filesystem or an
 * S3-compatible API) and the kernel returns a ready {@link StorageProvider}.
 * This keeps every piece of byte-transfer, presigning and credential machinery
 * on the kernel side: a plugin never imports `@stackpanel/db` or the AWS SDK,
 * exactly like `ctx.wallet` never exposes Prisma (ADR-0008).
 */
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  StorageBackendSpec,
  StorageProvider,
  StorageProviderObjectStat,
  StoragePutTarget,
  StorageGetTarget,
} from '@stackpanel/sdk';
import {
  LocalDiskDriver,
  S3Driver,
  type LocalStorageConfig,
  type S3StorageConfig,
} from '@stackpanel/db';
import { isMetadataHostname } from '@stackpanel/net-guard';

/**
 * Reject an endpoint pointed at a cloud-metadata service.
 *
 * The provider spec is admin-supplied (via the storage plugin), and the kernel
 * is the one that ultimately connects, so this is a genuine SSRF surface: a
 * crafted endpoint like `http://169.254.169.254` would make the kernel issue
 * requests to the instance metadata service. Private/loopback addresses stay
 * allowed because self-hosted MinIO (and a LAN image host) commonly lives on an
 * internal network or the same host — we only block link-local (metadata)
 * targets. Non-http(s) schemes are rejected too.
 */
function assertSafeHttpEndpoint(endpoint: string, label: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`非法的 ${label}：${endpoint}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} 仅支持 http/https：${endpoint}`);
  }
  if (isMetadataHostname(url.hostname)) {
    throw new Error(`${label} 指向云元数据地址，已拒绝：${url.hostname}`);
  }
}

/** A key→path mapper that rejects escapes (local backend). */
function safePath(root: string, key: string): string {
  const full = resolve(root, key);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`非法的 storage key：${key}`);
  }
  return full;
}

/** local filesystem backend, exposed through the zero-copy `spool` channel. */
function localProvider(spec: Extract<StorageBackendSpec, { driver: 'local' }>): StorageProvider {
  const root = resolve(spec.root);
  const driver = new LocalDiskDriver({
    driver: 'local',
    root,
    publicBaseUrl: spec.publicBaseUrl || '/storage',
  } satisfies LocalStorageConfig);
  return {
    id: 'storage.local',
    name: '服务器本地盘',
    byteMode: 'spool',
    async beginPut(input): Promise<StoragePutTarget> {
      return { spoolPath: safePath(root, input.key) };
    },
    async prepareGet(key): Promise<StorageGetTarget> {
      return { spoolPath: safePath(root, key) };
    },
    delete: (key) => driver.delete(key),
    exists: (key) => driver.exists(key),
    stat: (key) => driver.stat(key),
    list: (prefix) => driver.list(prefix),
    url: (key) => driver.url(key),
    async ping(): Promise<boolean> {
      return true;
    },
  };
}

/** S3-compatible backend, exposed through the pre-signed `redirect` channel. */
function s3Provider(spec: Extract<StorageBackendSpec, { driver: 's3' }>): StorageProvider {
  if (spec.endpoint) assertSafeHttpEndpoint(spec.endpoint, 'S3 endpoint');
  const publicBaseUrl =
    spec.publicBaseUrl ||
    (spec.endpoint
      ? `${spec.endpoint.replace(/\/$/, '')}/${spec.bucket}`
      : `https://${spec.bucket}.s3.amazonaws.com`);
  const driver = new S3Driver({
    driver: 's3',
    region: spec.region,
    bucket: spec.bucket,
    accessKeyId: spec.accessKeyId,
    secretAccessKey: spec.secretAccessKey,
    forcePathStyle: spec.forcePathStyle ?? true,
    publicBaseUrl,
    ...(spec.endpoint ? { endpoint: spec.endpoint } : {}),
  } satisfies S3StorageConfig);
  return {
    id: 'storage.s3',
    name: 'S3 兼容存储',
    byteMode: 'redirect',
    async beginPut(input): Promise<StoragePutTarget> {
      const uploadUrl = await driver.signedPutUrl(input.key, {
        ...(input.contentType ? { contentType: input.contentType } : {}),
      });
      return { uploadUrl };
    },
    async prepareGet(key, expiresInSeconds): Promise<StorageGetTarget> {
      return { url: await driver.signedUrl(key, expiresInSeconds) };
    },
    delete: (key) => driver.delete(key),
    exists: (key) => driver.exists(key),
    stat: (key): Promise<StorageProviderObjectStat | null> => driver.stat(key),
    list: (prefix) => driver.list(prefix),
    url: (key) => driver.url(key),
    async ensureReady(): Promise<void> {
      await driver.ensureBucket();
    },
    ping: () => driver.ping(),
  };
}

/**
 * Custom HTTP image host backend, exposed through the streaming `proxy` channel.
 *
 * The host has no pre-signing, so the kernel hands the bytes to this provider in
 * bounded chunks (`writeChunk`), which buffers them and performs one upload
 * (`PUT` raw or multipart `POST`) on `commitPut`. Reads use HTTP `Range`
 * requests; deletes use `DELETE`. The kernel owns the channel, so the same
 * provider works for a trusted plugin and (via chunked IPC) an isolated one.
 */
function httpProvider(spec: Extract<StorageBackendSpec, { driver: 'http' }>): StorageProvider {
  assertSafeHttpEndpoint(spec.uploadUrl, '图床上传地址');
  assertSafeHttpEndpoint(spec.publicBaseUrl, '图床访问地址');
  const base = spec.publicBaseUrl.replace(/\/$/, '');
  const method = spec.method ?? 'PUT';
  const headers = spec.headers ?? {};
  const objectUrl = (key: string): string => `${base}/${key}`;

  /**
   * Every outbound request re-asserts the endpoint (so a `{key}` placeholder
   * cannot smuggle the request to a metadata host) and refuses to follow
   * redirects — a `302` to `169.254.169.254` would otherwise defeat the check.
   */
  const guardedFetch = (url: string, init: RequestInit, label: string): Promise<Response> => {
    assertSafeHttpEndpoint(url, label);
    return fetch(url, { ...init, redirect: 'error' });
  };

  /** Per-key upload buffer, filled by `writeChunk` and flushed by `commitPut`. */
  const pending = new Map<string, { chunks: Uint8Array[]; contentType?: string; size: number }>();

  const buildBody = (key: string, data: Uint8Array, contentType?: string): { body: Uint8Array; requestHeaders: Record<string, string> } => {
    if (method === 'POST') {
      const boundary = `----stackpanel${randomUUID().replace(/-/g, '')}`;
      const field = spec.fieldName ?? 'file';
      const filename = key.split('/').pop() || 'object';
      const head =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType ?? 'application/octet-stream'}\r\n\r\n`;
      const tail = `\r\n--${boundary}--\r\n`;
      const body = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(data), Buffer.from(tail, 'utf8')]);
      return {
        body,
        requestHeaders: {
          ...headers,
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(body.length),
        },
      };
    }
    return {
      body: data,
      requestHeaders: {
        ...headers,
        ...(contentType ? { 'content-type': contentType } : {}),
        'content-length': String(data.length),
      },
    };
  };

  return {
    id: 'storage.http',
    name: '自定义 HTTP 图床',
    byteMode: 'proxy',

    async beginPut(input): Promise<StoragePutTarget> {
      if (!pending.has(input.key)) {
        pending.set(input.key, {
          chunks: [],
          ...(input.contentType ? { contentType: input.contentType } : {}),
          size: input.size,
        });
      }
      return { proxy: true };
    },

    async writeChunk(input): Promise<void> {
      const entry = pending.get(input.key) ?? { chunks: [], size: input.size };
      entry.chunks.push(input.data.slice());
      entry.size = input.size;
      pending.set(input.key, entry);
    },

    async commitPut({ key }): Promise<void> {
      const entry = pending.get(key);
      if (!entry) return;
      pending.delete(key);
      const data = Buffer.concat(entry.chunks.map((chunk) => Buffer.from(chunk)));
      const { body, requestHeaders } = buildBody(key, data, entry.contentType);
      // Upload URL may embed the object key (e.g. `https://host/api/upload?path={key}`).
      const uploadUrl = spec.uploadUrl.replace('{key}', key);
      const response = await guardedFetch(uploadUrl, { method, headers: requestHeaders, body }, '图床上传地址');
      if (!response.ok) {
        throw new Error(`上传到图床失败：HTTP ${response.status}`);
      }
    },

    async abortPut({ key }): Promise<void> {
      pending.delete(key);
    },

    async prepareGet(): Promise<StorageGetTarget> {
      return { proxy: true };
    },

    async readChunk(input): Promise<Uint8Array | null> {
      const end = input.offset + input.length - 1;
      const response = await guardedFetch(
        objectUrl(input.key),
        { headers: { ...headers, range: `bytes=${input.offset}-${end}` } },
        '图床读取地址',
      );
      if (response.status === 416) return new Uint8Array(0);
      if (!response.ok) return null;
      const buffer = new Uint8Array(await response.arrayBuffer());
      // A 206 (or a host that honours Range) returns exactly the requested
      // window. A host that ignores Range returns the whole object, so slice it.
      if (response.status === 206) return buffer;
      return buffer.subarray(input.offset, input.offset + input.length);
    },

    async delete(key): Promise<void> {
      const target = spec.deleteUrlTemplate
        ? spec.deleteUrlTemplate.replace('{key}', key)
        : objectUrl(key);
      await guardedFetch(target, { method: 'DELETE', headers }, '图床删除地址').catch(() => undefined);
    },

    async exists(key): Promise<boolean> {
      const response = await guardedFetch(objectUrl(key), { method: 'HEAD', headers }, '图床读取地址')
        .catch(() => null);
      return response?.ok ?? false;
    },

    async stat(key): Promise<StorageProviderObjectStat | null> {
      const response = await guardedFetch(objectUrl(key), { method: 'HEAD', headers }, '图床读取地址')
        .catch(() => null);
      if (!response?.ok) return null;
      const length = Number(response.headers.get('content-length'));
      const lastModified = response.headers.get('last-modified');
      return {
        key,
        size: Number.isFinite(length) ? length : 0,
        ...(lastModified ? { lastModified: new Date(lastModified).toISOString() } : {}),
      };
    },

    // Image hosts rarely expose a bucket listing; return nothing so the router
    // falls back to the env driver.
    async list(): Promise<StorageProviderObjectStat[]> {
      return [];
    },

    url(key): string {
      return objectUrl(key);
    },

    async ping(): Promise<boolean> {
      const response = await guardedFetch(base, { method: 'HEAD' }, '图床访问地址').catch(() => null);
      return response?.ok ?? false;
    },
  };
}

/** Build the kernel storage capability. */
export function createStorageService(): {
  backend(spec: StorageBackendSpec): Promise<StorageProvider>;
} {
  return {
    async backend(spec) {
      if (spec.driver === 's3') return s3Provider(spec);
      if (spec.driver === 'http') return httpProvider(spec);
      return localProvider(spec);
    },
  };
}
