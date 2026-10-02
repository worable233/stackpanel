import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDiskDriver } from '../src/storage/local.ts';

/**
 * The optional `signedUrl` capability (ADR-0014 §2): the local driver proxies
 * bytes through the API, so it has no secret to sign and returns its public
 * path. The S3 driver mints a real presigned URL; that path is covered by the
 * S3 integration surface rather than here.
 */
describe('LocalDiskDriver.signedUrl', () => {
  let root: string;
  let driver: LocalDiskDriver;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sp-storage-signed-'));
    driver = new LocalDiskDriver({ driver: 'local', root, publicBaseUrl: '/storage' });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns the API-served public path', async () => {
    expect(await driver.signedUrl('brand/logo.png')).toBe('/storage/brand/logo.png');
    expect(await driver.signedUrl('brand/logo.png', 60)).toBe('/storage/brand/logo.png');
  });

  it('rejects traversal keys', async () => {
    await expect(driver.signedUrl('../escape')).rejects.toThrow();
  });
});
