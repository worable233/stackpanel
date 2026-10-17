import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageProvider, StorageProviderObjectStat } from '@stackpanel/sdk';
import { STORAGE_PROXY_CHUNK_BYTES } from '@stackpanel/sdk';
import { LocalDiskDriver, type StorageDriver } from '@stackpanel/db';
import { KernelStorageRouter, resolveStorageDriver } from '../../src/storage/provider-router.ts';
import { createStorageService } from '../../src/storage/backend.ts';

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
      const value = objects.get(key);
      return value ? { key, size: value.length } : null;
    },
    async list(prefix = '') {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, size: value.length }));
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
    expect(calls[0]?.url).toBe('https://example.test/put');
    expect(new TextDecoder().decode(calls[0]?.body)).toBe('hello');
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

  it('redirect: refuses a provider-supplied upload URL pointed at cloud metadata', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const provider = fakeProvider({
      byteMode: 'redirect',
      async beginPut() {
        return { uploadUrl: 'http://169.254.169.254/latest/meta-data' };
      },
    });
    const router = new KernelStorageRouter(provider, memoryDriver());
    await expect(router.put('media/a.txt', new Uint8Array([1]))).rejects.toThrow(
      /元数据|metadata/i,
    );
    expect(fetchSpy, 'must not issue the request at all').not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('redirect: refuses a provider-supplied read URL pointed at cloud metadata', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const provider = fakeProvider({
      async stat(key) {
        return { key, size: 1 };
      },
      async prepareGet() {
        return { url: 'http://metadata.google.internal/latest/meta-data' };
      },
    });
    const router = new KernelStorageRouter(provider, memoryDriver());
    await expect(router.get('media/a.txt')).rejects.toThrow(/元数据|metadata/i);
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it('proxy: streams the object into writeChunk in bounded chunks and commits', async () => {
    const writes: Array<{ offset: number; data: Uint8Array; size: number }> = [];
    const commit = vi.fn(async () => {});
    const provider = fakeProvider({
      byteMode: 'proxy',
      async beginPut() {
        return { proxy: true };
      },
      async writeChunk(input) {
        writes.push({ offset: input.offset, data: input.data, size: input.size });
      },
      commitPut: commit,
    });
    const router = new KernelStorageRouter(provider, memoryDriver());
    const payload = new Uint8Array(STORAGE_PROXY_CHUNK_BYTES * 2 + 7).fill(3);
    await router.put('media/big.bin', payload);

    // Multiple bounded chunks, not one over-limit frame.
    expect(writes.length).toBe(3);
    // Offsets are ascending and contiguous.
    expect(writes.map((w) => w.offset)).toEqual([0, STORAGE_PROXY_CHUNK_BYTES, STORAGE_PROXY_CHUNK_BYTES * 2]);
    // Reassembling the chunks reproduces the original bytes.
    const total = writes.reduce((sum, w) => sum + w.data.length, 0);
    expect(total).toBe(payload.length);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const w of writes) { out.set(w.data, cursor); cursor += w.data.length; }
    expect(out).toEqual(payload);
    expect(commit).toHaveBeenCalledWith({ key: 'media/big.bin' });
  });

  it('proxy: still writes an empty object once', async () => {
    const writes: number[] = [];
    const provider = fakeProvider({
      byteMode: 'proxy',
      async beginPut() { return { proxy: true }; },
      async writeChunk(input) { writes.push(input.data.length); },
    });
    const router = new KernelStorageRouter(provider, memoryDriver());
    await router.put('media/empty.bin', new Uint8Array(0));
    expect(writes).toEqual([0]);
  });

  it('proxy: aborts when the provider lacks writeChunk', async () => {
    const abort = vi.fn(async () => {});
    const provider = fakeProvider({
      byteMode: 'proxy',
      async beginPut() { return { proxy: true }; },
      abortPut: abort,
    });
    const router = new KernelStorageRouter(provider, memoryDriver());
    await expect(router.put('media/x.bin', new Uint8Array([1]))).rejects.toThrow(/writeChunk/);
    expect(abort).toHaveBeenCalled();
  });

  it('proxy: reads the object back through readChunk until short', async () => {
    const bytes = new Uint8Array(STORAGE_PROXY_CHUNK_BYTES + 11).fill(7);
    const provider = fakeProvider({
      byteMode: 'proxy',
      async stat(key) { return { key, size: bytes.length }; },
      async prepareGet() { return { proxy: true }; },
      async readChunk(input) {
        if (input.offset >= bytes.length) return null;
        return bytes.subarray(input.offset, Math.min(input.offset + input.length, bytes.length));
      },
    });
    const router = new KernelStorageRouter(provider, memoryDriver());
    const got = await router.get('media/big.bin');
    expect(got).toEqual(bytes);
  });

  it('proxy: read returns null when the provider yields nothing for a non-empty object', async () => {
    const provider = fakeProvider({
      byteMode: 'proxy',
      async stat(key) { return { key, size: 100 }; },
      async prepareGet() { return { proxy: true }; },
      async readChunk() { return null; },
    });
    const router = new KernelStorageRouter(provider, memoryDriver());
    expect(await router.get('media/gone.bin')).toBeNull();
  });

  it('proxy: read aborts when the provider lacks readChunk', async () => {
    const provider = fakeProvider({
      byteMode: 'proxy',
      async stat(key) { return { key, size: 1 }; },
      async prepareGet() { return { proxy: true }; },
    });
    const router = new KernelStorageRouter(provider, memoryDriver());
    await expect(router.get('media/x.bin')).rejects.toThrow(/readChunk/);
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

describe('KernelStorageRouter provisioning', () => {
  it('ensureBucket delegates to the provider provisioning hook', async () => {
    const ensureReady = vi.fn(async () => {});
    const router = new KernelStorageRouter(fakeProvider({ ensureReady }), memoryDriver());
    await router.ensureBucket();
    expect(ensureReady).toHaveBeenCalledTimes(1);
  });

  it('ensureBucket is a no-op when the provider has no provisioning hook', async () => {
    const router = new KernelStorageRouter(fakeProvider(), memoryDriver());
    await expect(router.ensureBucket()).resolves.toBeUndefined();
  });
});

// Keep the import used so the local driver shape stays referenced (type parity).
void LocalDiskDriver;

describe('storage backend SSRF guard (kernel side)', () => {
  const service = createStorageService();

  it('rejects S3 endpoints pointed at cloud metadata addresses', async () => {
    for (const endpoint of [
      'http://169.254.169.254',
      'http://169.254.169.254:80/latest/meta-data',
      'http://metadata.google.internal',
      'http://[fe80::1]',
    ]) {
      await expect(
        service.backend({
          driver: 's3',
          endpoint,
          region: 'us-east-1',
          bucket: 'b',
          accessKeyId: 'k',
          secretAccessKey: 's',
        }),
        endpoint,
      ).rejects.toThrow(/元数据|metadata/i);
    }
  });

  it('rejects non-http(s) endpoints', async () => {
    await expect(
      service.backend({
        driver: 's3',
        endpoint: 'file:///etc/passwd',
        region: 'us-east-1',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
      }),
    ).rejects.toThrow();
  });

  it('accepts private/loopback endpoints for self-hosted MinIO', async () => {
    // The guard must not block an internal endpoint; construction succeeds.
    await expect(
      service.backend({
        driver: 's3',
        endpoint: 'http://127.0.0.1:9000',
        region: 'us-east-1',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
      }),
    ).resolves.toMatchObject({ id: 'storage.s3' });
    await expect(
      service.backend({
        driver: 's3',
        endpoint: 'http://minio.internal:9000',
        region: 'us-east-1',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
      }),
    ).resolves.toMatchObject({ id: 'storage.s3' });
  });
});

describe('storage http backend (proxy channel, real HTTP server)', () => {
  /** A tiny in-memory image host: PUT stores, GET (with Range) serves, DELETE drops. */
  async function startImageHost(): Promise<{ url: string; close: () => Promise<void>; files: Map<string, Buffer> }> {
    const files = new Map<string, Buffer>();
    const server = createServer((req, res) => {
      const key = decodeURIComponent((req.url ?? '/').replace(/^\//, ''));
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          files.set(key, Buffer.concat(chunks));
          res.statusCode = 200;
          res.end('ok');
        });
        return;
      }
      if (req.method === 'HEAD') {
        const body = files.get(key);
        if (!body) { res.statusCode = 404; res.end(); return; }
        res.setHeader('content-length', String(body.length));
        res.statusCode = 200;
        res.end();
        return;
      }
      if (req.method === 'GET') {
        const body = files.get(key);
        if (!body) { res.statusCode = 404; res.end(); return; }
        const range = req.headers['range'];
        if (typeof range === 'string') {
          const match = /^bytes=(\d+)-(\d+)?$/.exec(range);
          if (match) {
            const start = Number(match[1]);
            const end = match[2] ? Number(match[2]) : body.length - 1;
            const slice = body.subarray(start, end + 1);
            res.statusCode = 206;
            res.setHeader('content-range', `bytes ${start}-${start + slice.length - 1}/${body.length}`);
            res.setHeader('content-length', String(slice.length));
            res.end(slice);
            return;
          }
        }
        res.statusCode = 200;
        res.setHeader('content-length', String(body.length));
        res.end(body);
        return;
      }
      if (req.method === 'DELETE') {
        files.delete(key);
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 405;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return {
      url: `http://127.0.0.1:${port}`,
      files,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('stores chunked bytes via PUT and serves them back through Range reads', async () => {
    const host = await startImageHost();
    try {
      const service = createStorageService();
      const provider = await service.backend({
        driver: 'http',
        uploadUrl: `${host.url}/{key}`,
        publicBaseUrl: host.url,
        method: 'PUT',
      });
      const router = new KernelStorageRouter(provider, memoryDriver());
      const payload = new Uint8Array(STORAGE_PROXY_CHUNK_BYTES * 2 + 5);
      for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

      await router.put('media/pic.png', payload);
      // The host really received the object under the same key we read back.
      const stored = host.files.get('media/pic.png');
      expect(stored, 'bytes must reach the image host').toBeDefined();
      expect(stored?.length).toBe(payload.length);

      // Reading goes back through Range requests and reconstructs the object.
      const got = await router.get('media/pic.png');
      expect(got).toEqual(payload);

      expect(await router.exists('media/pic.png')).toBe(true);
      const stat = await router.stat('media/pic.png');
      expect(stat?.size).toBe(payload.length);
    } finally {
      await host.close();
    }
  });

  it('uploads with multipart POST when configured', async () => {
    let received = Buffer.alloc(0);
    let contentType = '';
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      contentType = String(req.headers['content-type'] ?? '');
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => { received = Buffer.concat(chunks); res.statusCode = 200; res.end('ok'); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const service = createStorageService();
      const provider = await service.backend({
        driver: 'http',
        uploadUrl: `http://127.0.0.1:${port}/upload`,
        publicBaseUrl: `http://127.0.0.1:${port}`,
        method: 'POST',
        fieldName: 'file',
      });
      const router = new KernelStorageRouter(provider, memoryDriver());
      await router.put('media/a.txt', new TextEncoder().encode('hello'));
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(received.toString('utf8')).toContain('name="file"');
      expect(received.toString('utf8')).toContain('hello');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects an upload URL pointed at the cloud metadata service', async () => {
    const service = createStorageService();
    await expect(
      service.backend({
        driver: 'http',
        uploadUrl: 'http://169.254.169.254/upload',
        publicBaseUrl: 'http://example.test',
      }),
    ).rejects.toThrow(/元数据|metadata/i);
  });

  it('rejects a public base URL pointed at the cloud metadata service', async () => {
    const service = createStorageService();
    await expect(
      service.backend({
        driver: 'http',
        uploadUrl: 'http://example.test/upload',
        publicBaseUrl: 'http://metadata.google.internal',
      }),
    ).rejects.toThrow(/元数据|metadata/i);
  });

  it('allows a private/loopback image host', async () => {
    const service = createStorageService();
    await expect(
      service.backend({
        driver: 'http',
        uploadUrl: 'http://127.0.0.1:8080/upload',
        publicBaseUrl: 'http://127.0.0.1:8080',
      }),
    ).resolves.toMatchObject({ id: 'storage.http', byteMode: 'proxy' });
  });

  it('refuses to follow a redirect from the image host (redirect:error)', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const service = createStorageService();
      const provider = await service.backend({
        driver: 'http',
        uploadUrl: `http://127.0.0.1:${port}/{key}`,
        publicBaseUrl: `http://127.0.0.1:${port}`,
      });
      const router = new KernelStorageRouter(provider, memoryDriver());
      // The upload request itself must fail rather than chase the 302.
      await expect(router.put('media/x.bin', new TextEncoder().encode('hi'))).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
