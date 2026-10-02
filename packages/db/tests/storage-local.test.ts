import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalDiskDriver } from '../src/storage/local.ts';

let root: string;
let driver: LocalDiskDriver;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-storage-'));
  driver = new LocalDiskDriver({ driver: 'local', root, publicBaseUrl: '/storage' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalDiskDriver', () => {
  it('puts, gets and deletes an object', async () => {
    const bytes = new TextEncoder().encode('hello');
    await driver.put('brand/logo.png', bytes, { contentType: 'image/png' });
    expect(await driver.get('brand/logo.png')).toEqual(bytes);
    expect(await driver.exists('brand/logo.png')).toBe(true);

    await driver.delete('brand/logo.png');
    expect(await driver.get('brand/logo.png')).toBeNull();
    expect(await driver.exists('brand/logo.png')).toBe(false);
  });

  it('get returns null for a missing object and delete is a no-op', async () => {
    expect(await driver.get('nope.png')).toBeNull();
    await driver.delete('nope.png');
  });

  it('lists objects under a prefix with metadata', async () => {
    await driver.put('a/one.txt', new TextEncoder().encode('1'));
    await driver.put('a/two.txt', new TextEncoder().encode('22'));
    await driver.put('b/three.txt', new TextEncoder().encode('333'));

    const underA = await driver.list('a');
    expect(underA.map((o) => o.key).sort()).toEqual(['a/one.txt', 'a/two.txt']);
    expect(underA.find((o) => o.key === 'a/two.txt')?.size).toBe(2);

    const all = await driver.list();
    expect(all).toHaveLength(3);
  });

  it('stat reports size/lastModified and null when missing', async () => {
    await driver.put('x/y.bin', new Uint8Array(5));
    const info = await driver.stat('x/y.bin');
    expect(info?.size).toBe(5);
    expect(info?.lastModified).toBeTruthy();
    expect(await driver.stat('x/missing.bin')).toBeNull();
  });

  it('builds public URLs from the configured base', () => {
    expect(driver.url('brand/logo.png')).toBe('/storage/brand/logo.png');
  });

  it('rejects traversal keys', async () => {
    await expect(driver.put('../escape', new Uint8Array(1))).rejects.toThrow();
    await expect(driver.put('/abs', new Uint8Array(1))).rejects.toThrow();
    await expect(driver.get('a/../../b')).rejects.toThrow();
    await expect(driver.get('')).rejects.toThrow();
  });
});
