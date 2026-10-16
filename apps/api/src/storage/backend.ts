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
 * Reject an S3 endpoint pointed at a cloud-metadata service.
 *
 * The provider spec is admin-supplied (via the storage plugin), and the kernel
 * is the one that ultimately connects, so this is a genuine SSRF surface: a
 * crafted endpoint like `http://169.254.169.254` would make the kernel issue
 * signed requests to the instance metadata service. Private/loopback addresses
 * stay allowed because self-hosted MinIO commonly lives on an internal network
 * or the same host — we only block link-local (metadata) targets.
 */
function assertSafeS3Endpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`非法的 S3 endpoint：${endpoint}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`S3 endpoint 仅支持 http/https：${endpoint}`);
  }
  if (isMetadataHostname(url.hostname)) {
    throw new Error(`S3 endpoint 指向云元数据地址，已拒绝：${url.hostname}`);
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
  if (spec.endpoint) assertSafeS3Endpoint(spec.endpoint);
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

/** Build the kernel storage capability. */
export function createStorageService(): {
  backend(spec: StorageBackendSpec): Promise<StorageProvider>;
} {
  return {
    async backend(spec) {
      return spec.driver === 's3' ? s3Provider(spec) : localProvider(spec);
    },
  };
}
