import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { S3StorageConfig } from '../config.ts';
import {
  assertSafeStorageKey,
  type PutObjectOptions,
  type StorageDriver,
  type StorageObjectStat,
} from './types.ts';

/**
 * S3-compatible storage driver (AWS S3 / MinIO / Cloudflare R2 / Aliyun OSS).
 *
 * Production default (ADR-0014). `forcePathStyle` is on by default because
 * MinIO and most self-hosted gateways do not support virtual-host addressing.
 */
export class S3Driver implements StorageDriver {
  readonly kind = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /** Create the bucket when missing. Safe to call on every startup. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
      return;
    } catch {
      // Fall through and try to create it.
    }
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
    } catch (err) {
      const name = (err as { name?: string }).name;
      // A concurrent replica may have created it first.
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
        throw err;
      }
    }
  }

  /** Reachability probe used by readiness checks. */
  async ping(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async put(key: string, data: Uint8Array, options: PutObjectOptions = {}): Promise<void> {
    assertSafeStorageKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: data,
        ...(options.contentType ? { ContentType: options.contentType } : {}),
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertSafeStorageKey(key);
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      if (!res.Body) return null;
      return await res.Body.transformToByteArray();
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeStorageKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async stat(key: string): Promise<StorageObjectStat | null> {
    assertSafeStorageKey(key);
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        key,
        size: res.ContentLength ?? 0,
        ...(res.LastModified ? { lastModified: res.LastModified.toISOString() } : {}),
      };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async list(prefix = ''): Promise<StorageObjectStat[]> {
    const out: StorageObjectStat[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          ...(prefix ? { Prefix: prefix } : {}),
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const item of res.Contents ?? []) {
        if (!item.Key) continue;
        out.push({
          key: item.Key,
          size: item.Size ?? 0,
          ...(item.LastModified ? { lastModified: item.LastModified.toISOString() } : {}),
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  url(key: string): string {
    const base = this.config.publicBaseUrl.replace(/\/$/, '');
    return `${base}/${key}`;
  }

  /**
   * Presigned GET URL for a non-public object (ADR-0014 §2). Defaults to a
   * short 15-minute window so a leaked URL has a bounded blast radius.
   */
  async signedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    assertSafeStorageKey(key);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      {
        expiresIn: Math.max(1, Math.floor(expiresInSeconds)),
      },
    );
  }
}
