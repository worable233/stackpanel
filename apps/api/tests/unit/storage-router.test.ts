import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageProvider, StorageProviderObjectStat } from '@stackpanel/sdk';
import { LocalDiskDriver, type StorageDriver } from '@stackpanel/db';
import { KernelStorageRouter, resolveStorageDriver } from '../../src/storage/provider-router.ts';

/** A tiny in-memory driver used as the env fallback. */
function memoryDriver(): StorageDriver & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    kind: 'local',
    objects,
    async put(key, data) {
      objects.set(key, data);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async exists(key) {
      return objects.has(key);
    },
    async stat(key) {
      return objects.has(key) ? { key, size: objects.get(key)!.length } : null;
    },
    async list(prefix = '') {
      return [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, size: objects.get(key)!.length }));
    },
    url(key) {
      return `/fallback/${key}`;
    },
  };
}

/** A provider that records calls; each test customises the channel returned. */
function fakeProvider(overrides: Partial<StorageProvider> = {}): StorageProvider {
  return {
    id: 'test',
    name: 'Test',
    byteMode: 'spool',
    async beginPut() {
      return {};
    },
    async prepareGet() {
      return { spoolPath: '/nonexistent' };
    },
    async delete() {},
    async exists() {
      return false;
    },
    async stat(): Promise<StorageProviderObjectStat | null> {
      return null;
    },
    async list() {
      return [];
    },
    url(key) {
      return `/provider/${key}`;
    },
    ...overrides,
  };
}

describe('KernelStorageRouter', () => {
  let dir: string;
  let spoolTarget: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sp-router-'));
    spoolTarget = path.join(dir, 'object.bin');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('spool: writes in place at a provider-owned path and commits', async () => {
    const commit = vi.fn(async () => {});
    const provider = fakeProvider({
      byteMode: 'spool',
      async beginPut(input) {
        return { spoolPath: path.join(dir, input.key) };
      },
      commitPut: commit,
    });
    const router = new KernelStorageRouter(provider, memoryDriver());
    await router.put('media/a.txt', new TextEncoder().encode('hello'));
    expect(await readFile(path.join(dir, 'media/a.txt'), 'utf8')).toBe('hello');
    expect(commit).toHaveBeenCalledWith({ key: 'media/a.txt' });
  });

  it('redirect: PUTs to the returned upload URL', async () => {
    const calls: Array<{ url: string; body: Uint8Array }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as Uint8Array });
      return new Response(null, { status: 200 });
    });
    const provider = fakeProvider({
      byteMode: 'redirect',
      async beginPut() {
        return { uploadUrl: 'https://example.test/put', headers: { 'x-amz-acl': 'private' } };
      },
    });
    const router = new KernelStorageRouter(provider, memoryDriver());
    await router.put('media/a.txt', new TextEncoder().encode('hello'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://example.test/put');
    expect(new TextDecoder().decode(calls[0]!.body)).toBe('hello');
    vi.unstubAllGlobals();
  });

  it('redirect: a failed upload throws and calls abortPut', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 403 }));
    const abort = vi.fn(async () => {});
    const provider = fakeProvider({
      byteMode: 'redirect',
      async beginPut() {
        return { uploadUrl: 'https://example.test/put' };
      },
      abortPut: abort,
    });
    const router = new KernelStorageRouter(provider, memoryDriver());
    await expect(router.put('media/a.txt', new Uint8Array([1]))).rejects.toThrow(/403/);
    expect(abort).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('an empty target delegates the write to the env fallback', async () => {
    const fallback = memoryDriver();
    const provider = fakeProvider({ async beginPut() { return {}; } });
    const router = new KernelStorageRouter(provider, fallback);
    await router.put('media/a.txt', new TextEncoder().encode('env'));
    expect(fallback.objects.get('media/a.txt')?.length).toBe(3);
  });

  it('get falls back to the env driver when the provider lacks the object', async () => {
    const fallback = memoryDriver();
    await fallback.put('brand/logo.png', new Uint8Array([9, 9]));
    const provider = fakeProvider({
      async stat() {
        return null; // provider does not have it
      },
    });
    const router = new KernelStorageRouter(provider, fallback);
    expect(await router.get('brand/logo.png')).toEqual(new Uint8Array([9, 9]));
  });

  it('get reads provider bytes through a spool file', async () => {
    await writeFile(spoolTarget, new Uint8Array([1, 2, 3]));
    const provider = fakeProvider({
      async stat(key) {
        return { key, size: 3 };
      },
      async prepareGet() {
        return { spoolPath: spoolTarget };
      },
    });
    const router = new KernelStorageRouter(provider, memoryDriver());
    expect(await router.get('media/x.png')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects an unsafe storage key', async () => {
    const router = new KernelStorageRouter(fakeProvider(), memoryDriver());
    await expect(router.put('../escape', new Uint8Array([1]))).rejects.toThrow();
  });
});

describe('resolveStorageDriver', () => {
  it('returns the fallback when no provider is registered', () => {
    const fallback = memoryDriver();
    const driver = resolveStorageDriver({ getExtensions: <T>() => [] as T[] }, fallback);
    expect(driver).toBe(fallback);
  });

  it('wraps the first registered provider in a router', () => {
    const fallback = memoryDriver();
    const provider = fakeProvider();
    const driver = resolveStorageDriver(
      { getExtensions: <T>() => [provider] as T[] },
      fallback,
    );
    expect(driver).toBeInstanceOf(KernelStorageRouter);
  });
});

// Keep the import used so the local driver shape stays referenced (type parity).
void LocalDiskDriver;
