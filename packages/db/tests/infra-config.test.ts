import { describe, expect, it } from 'vitest';
import { InfraConfigError, readInfraConfig } from '../src/config.ts';

const dataDir = '/data';

describe('readInfraConfig', () => {
  it('defaults to local storage when only STORAGE_DRIVER is unset (dev)', () => {
    const config = readInfraConfig({ env: { NODE_ENV: 'development' }, dataDir });
    expect(config.production).toBe(false);
    expect(config.redisUrl).toBeUndefined();
    expect(config.storage).toEqual({
      driver: 'local',
      root: '/data/storage',
      publicBaseUrl: '/storage',
    });
  });

  it('parses a complete S3 configuration', () => {
    const config = readInfraConfig({
      env: {
        NODE_ENV: 'development',
        STORAGE_DRIVER: 's3',
        STORAGE_S3_ENDPOINT: 'http://minio:9000',
        STORAGE_S3_BUCKET: 'stackpanel',
        STORAGE_S3_ACCESS_KEY_ID: 'key',
        STORAGE_S3_SECRET_ACCESS_KEY: 'secret',
        STORAGE_S3_REGION: 'us-east-1',
      },
      dataDir,
    });
    expect(config.storage.driver).toBe('s3');
    if (config.storage.driver === 's3') {
      expect(config.storage.bucket).toBe('stackpanel');
      expect(config.storage.forcePathStyle).toBe(true);
      expect(config.storage.publicBaseUrl).toBe('http://minio:9000/stackpanel');
    }
  });

  it('rejects an unknown STORAGE_DRIVER', () => {
    expect(() =>
      readInfraConfig({ env: { NODE_ENV: 'development', STORAGE_DRIVER: 'gcs' }, dataDir }),
    ).toThrow(InfraConfigError);
  });

  it('rejects an incomplete S3 configuration', () => {
    expect(() =>
      readInfraConfig({
        env: { NODE_ENV: 'development', STORAGE_DRIVER: 's3', STORAGE_S3_BUCKET: 'x' },
        dataDir,
      }),
    ).toThrow(/STORAGE_S3_ACCESS_KEY_ID/);
  });

  it('requires Redis and S3-driven storage in production', () => {
    expect(() => readInfraConfig({ env: { NODE_ENV: 'production' }, dataDir })).toThrow(
      /REDIS_URL/,
    );
    expect(() =>
      readInfraConfig({
        env: { NODE_ENV: 'production', REDIS_URL: 'redis://localhost:6379' },
        dataDir,
      }),
    ).toThrow(/本地盘/);
  });

  it('accepts a fully provisioned production config', () => {
    const config = readInfraConfig({
      env: {
        NODE_ENV: 'production',
        REDIS_URL: 'redis://localhost:6379',
        STORAGE_DRIVER: 's3',
        STORAGE_S3_ENDPOINT: 'http://minio:9000',
        STORAGE_S3_BUCKET: 'stackpanel',
        STORAGE_S3_ACCESS_KEY_ID: 'key',
        STORAGE_S3_SECRET_ACCESS_KEY: 'secret',
      },
      dataDir,
    });
    expect(config.production).toBe(true);
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.storage.driver).toBe('s3');
  });
});
