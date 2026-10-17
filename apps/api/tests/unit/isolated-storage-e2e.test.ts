import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalDiskDriver } from '@stackpanel/db';
import type { PluginContext, PluginManifest } from '@stackpanel/sdk';
import { STORAGE_PROXY_CHUNK_BYTES } from '@stackpanel/sdk';
import { loadIsolatedPluginDefinition, stopIsolatedPlugin } from '../../src/plugins/isolated/host.ts';
import { createStorageService } from '../../src/storage/backend.ts';
import { KernelStorageRouter, resolveStorageDriver } from '../../src/storage/provider-router.ts';

/**
 * End-to-end proof that a *genuinely isolated* plugin can become the kernel's
 * storage backend.
 *
 * Unlike `isolated-rpc.test.ts` (which hand-plays the host protocol), this runs
 * the real worker process, the real host capability handlers (`storage.backend`
 * / `storage.invoke`), and the real `createStorageService` backend factory, so
 * nothing in the chain is a stub:
 *
 *   router.put → provider proxy (host) → IPC `storage.invoke` → worker impl
 *     → IPC `storage.backend` → host builds real LocalDiskDriver provider
 *       → worker returns a spool path owned by the isolated provider root
 *   → router writes the bytes there.
 */

const entry = fileURLToPath(new URL('../fixtures/isolated-storage-plugin.mjs', import.meta.url));
const proxyEntry = fileURLToPath(
  new URL('../fixtures/isolated-storage-proxy-plugin.mjs', import.meta.url),
);

interface TestContext {
  manifest: Record<string, unknown>;
  storage: ReturnType<typeof createStorageService>;
  registerExtension(pointId: string, implementation: unknown): () => void;
  getService(): undefined;
  getExtensionsWithOwner(): unknown[];
  getExtensions(): unknown[];
  logger: { info(): void; warn(): void; error(): void };
  effect(fn: (collect: (disposable: () => void) => void) => unknown): () => void;
}

/** A minimal but *real* PluginContext: real storage capability, capturing registry. */
function makeContext(storageRoot: string): { ctx: TestContext; extensions: Map<string, unknown[]> } {
  const extensions = new Map<string, unknown[]>();
  const ctx: TestContext = {
    manifest: { id: 'isolated-storage-e2e', name: 'Isolated storage', version: '1.0.0', storageRoot },
    storage: createStorageService(),
    registerExtension(pointId, implementation) {
      const list = extensions.get(pointId) ?? [];
      list.push(implementation);
      extensions.set(pointId, list);
      return () => {
        const index = list.indexOf(implementation);
        if (index >= 0) list.splice(index, 1);
      };
    },
    getService: () => undefined,
    getExtensionsWithOwner: () => [],
    getExtensions: () => [],
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    effect: (fn) => {
      fn(() => undefined);
      return () => undefined;
    },
  };
  return { ctx, extensions };
}

const cleanups: string[] = [];
afterEach(async () => {
  stopIsolatedPlugin('isolated-storage-e2e');
  stopIsolatedPlugin('isolated-storage-proxy-e2e');
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('isolated plugin as the kernel storage backend (real worker + real backend)', () => {
  it('routes puts/gets through a truly isolated provider into its own root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sp-isolated-root-'));
    const fallbackRoot = await mkdtemp(path.join(tmpdir(), 'sp-isolated-fallback-'));
    cleanups.push(root, fallbackRoot);

    const { ctx, extensions } = makeContext(root);
    // `storageRoot` rides along on the manifest (the host serializes whatever it
    // is handed); it is not part of the public PluginManifest type.
    const manifest = {
      id: 'isolated-storage-e2e',
      name: 'Isolated storage',
      version: '1.0.0',
      storageRoot: root,
    } as PluginManifest;
    const definition = await loadIsolatedPluginDefinition('isolated-storage-e2e', entry, manifest);
    await definition.onActivate?.(ctx as unknown as PluginContext);

    // The kernel resolves the isolated plugin's registered provider and wraps it.
    const fallback = new LocalDiskDriver({ driver: 'local', root: fallbackRoot, publicBaseUrl: '/storage' });
    const driver = resolveStorageDriver(
      { getExtensions: <T>(pointId: string) => (extensions.get(pointId) ?? []) as T[] },
      fallback,
    );
    expect(driver).toBeInstanceOf(KernelStorageRouter);
    expect(driver.kind).toBe('provider');

    const key = 'media/2026/01/iso/original.png';
    const bytes = new Uint8Array(Buffer.from('isolated-e2e-bytes-0123456789'));

    await driver.put(key, bytes, { contentType: 'image/png' });

    // Bytes landed in the *isolated provider's* root, not the env fallback.
    const stored = await readFile(path.join(root, key));
    expect(stored.equals(Buffer.from(bytes))).toBe(true);
    expect(await readFile(path.join(fallbackRoot, key)).catch(() => null)).toBeNull();

    // And they read back byte-for-byte through the same router.
    const read = await driver.get(key);
    expect(read).not.toBeNull();
    expect(Buffer.from(read as Uint8Array).equals(Buffer.from(bytes))).toBe(true);

    // The isolated provider's own control-plane calls went over the bridge.
    expect(await driver.stat(key)).toMatchObject({ key, size: bytes.length });
    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
    stopIsolatedPlugin('isolated-storage-e2e');
  }, 20_000);

  it('streams a large object through an isolated proxy provider in bounded chunks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sp-isolated-proxy-root-'));
    const fallbackRoot = await mkdtemp(path.join(tmpdir(), 'sp-isolated-proxy-fallback-'));
    cleanups.push(root, fallbackRoot);

    const { ctx, extensions } = makeContext(root);
    const manifest = {
      id: 'isolated-storage-proxy-e2e',
      name: 'Isolated storage proxy',
      version: '1.0.0',
      storageRoot: root,
    } as PluginManifest;
    const definition = await loadIsolatedPluginDefinition(
      'isolated-storage-proxy-e2e',
      proxyEntry,
      manifest,
    );
    await definition.onActivate?.(ctx as unknown as PluginContext);

    const fallback = new LocalDiskDriver({ driver: 'local', root: fallbackRoot, publicBaseUrl: '/storage' });
    const driver = resolveStorageDriver(
      { getExtensions: <T>(pointId: string) => (extensions.get(pointId) ?? []) as T[] },
      fallback,
    );

    const key = 'media/2026/01/iso-proxy/big.bin';
    // Deliberately larger than one IPC chunk (256 KiB) but still well under the
    // 1 MiB single-message cap per *chunk*, so the transport must chunk, not fail.
    const bytes = new Uint8Array(STORAGE_PROXY_CHUNK_BYTES * 2 + 123);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256;

    await driver.put(key, bytes, { contentType: 'application/octet-stream' });

    // The full object really arrived in the isolated worker and was flushed there.
    const stored = await readFile(path.join(root, key));
    expect(stored.length).toBe(bytes.length);
    expect(stored.equals(Buffer.from(bytes))).toBe(true);
    expect(await readFile(path.join(fallbackRoot, key)).catch(() => null)).toBeNull();

    // And it reads back byte-for-byte through chunked readChunk pulls.
    const read = await driver.get(key);
    expect(read).not.toBeNull();
    expect(Buffer.from(read as Uint8Array).equals(Buffer.from(bytes))).toBe(true);

    expect(await driver.stat(key)).toMatchObject({ key, size: bytes.length });
    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
    stopIsolatedPlugin('isolated-storage-proxy-e2e');
  }, 30_000);
});
