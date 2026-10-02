import type { StorageConfig } from '../config.ts';
import { LocalDiskDriver } from './local.ts';
import { S3Driver } from './s3.ts';
import type { StorageDriver } from './types.ts';

export type { LocalStorageConfig, S3StorageConfig, StorageConfig } from '../config.ts';
export {
  assertSafeStorageKey,
  contentTypeForKey,
  type PutObjectOptions,
  type StorageDriver,
  type StorageObjectStat,
} from './types.ts';
export { LocalDiskDriver } from './local.ts';
export { S3Driver } from './s3.ts';

/** Build the storage driver selected by configuration. */
export function createStorageDriver(config: StorageConfig): StorageDriver {
  return config.driver === 's3' ? new S3Driver(config) : new LocalDiskDriver(config);
}
