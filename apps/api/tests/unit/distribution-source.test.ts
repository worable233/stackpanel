import { describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import {
  catalogDigest,
  parsePackageSignatureFile,
  verifyCatalogSignature,
  verifyPackageSignatureBound,
} from '../../src/distribution/signatures.ts';
import {
  downloadAsset,
  fetchTextConditional,
  MemorySourceCache,
  parseRetryAfter,
  type SourceCache,
} from '../../src/distribution/github-source.ts';
import {
  fetchCatalogSequenced,
  mayInstallFromCatalog,
} from '../../src/distribution/catalog-client.ts';
import type { CatalogSnapshot, Keyring } from '@stackpanel/spec';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey,
  };
}

function signCatalog(privateKey: ReturnType<typeof keypair>['privateKey'], bytes: Uint8Array) {
  const digest = catalogDigest(bytes);
  const signature = edSign(null, Buffer.from(digest, 'utf8'), privateKey).toString('base64');
  return { algorithm: 'ed25519' as const, keyId: 'catalog-2026', digest, signature };
}

function catalogSnapshot(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    formatVersion: 1,
    sequence: 7,
    generatedAt: '2026-10-16T00:00:00.000Z',
    expiresAt: '2026-10-30T00:00:00.000Z',
    channels: [{ channel: 'stable', sequence: 7 }],
    publishers: [
      {
        publisher: 'stackpanel',
        keyIds: ['catalog-2026'],
        repositories: ['worable233/stackpanel-market'],
      },
    ],
    entries: [],
    ...overrides,
  };
}

describe('catalog signature verification', () => {
  it('accepts a valid signature and rejects tampering', () => {
    const { publicKeyPem, privateKey } = keypair();
    const keyring: Keyring = {
      formatVersion: 1,
      keys: [
        {
          keyId: 'catalog-2026',
          purpose: 'catalog',
          publicKeyPem,
          allowedRepositories: ['worable233/stackpanel-market'],
        },
      ],
    };
    const bytes = new TextEncoder().encode('{"hello":"world"}');
    const signature = signCatalog(privateKey, bytes);
    expect(() =>
      verifyCatalogSignature({
        catalogBytes: bytes,
        signature,
        keyring,
        repository: 'worable233/stackpanel-market',
      }),
    ).not.toThrow();

    // Tampered bytes.
    expect(() =>
      verifyCatalogSignature({
        catalogBytes: new TextEncoder().encode('{"hello":"tampered"}'),
        signature,
        keyring,
        repository: 'worable233/stackpanel-market',
      }),
    ).toThrow();

    // Untrusted repository.
    expect(() =>
      verifyCatalogSignature({
        catalogBytes: bytes,
        signature,
        keyring,
        repository: 'evil/market',
      }),
    ).toThrow();
  });
});

describe('package signature verification', () => {
  it('binds the key to publisher/repository and checks file hashes', () => {
    const { publicKeyPem, privateKey } = keypair();
    const keyring: Keyring = {
      formatVersion: 1,
      keys: [
        {
          keyId: 'pkg-stackpanel',
          purpose: 'package',
          publicKeyPem,
          publisher: 'stackpanel',
          allowedRepositories: ['worable233/stackpanel-plugins'],
        },
      ],
    };
    const files = new Map<string, Uint8Array>([
      ['manifest.json', new TextEncoder().encode('{"id":"store"}')],
      ['dist/index.js', new TextEncoder().encode('export default {}')],
    ]);
    const hashes: Record<string, string> = {};
    for (const name of [...files.keys()].sort()) {
      hashes[name] = createHash('sha256')
        .update(files.get(name) as Uint8Array)
        .digest('hex');
    }
    const payload = Buffer.from(JSON.stringify({ algorithm: 'ed25519', files: hashes }), 'utf8');
    const signature = edSign(null, payload, privateKey).toString('base64');
    files.set(
      'signature.json',
      new TextEncoder().encode(JSON.stringify({ algorithm: 'ed25519', files: hashes, signature })),
    );

    expect(() =>
      verifyPackageSignatureBound({
        files,
        keyId: 'pkg-stackpanel',
        expectedPublisher: 'stackpanel',
        expectedRepository: 'worable233/stackpanel-plugins',
        keyring,
      }),
    ).not.toThrow();

    // Wrong publisher → rejected without even parsing the signature.
    expect(() =>
      verifyPackageSignatureBound({
        files,
        keyId: 'pkg-stackpanel',
        expectedPublisher: 'impostor',
        expectedRepository: 'worable233/stackpanel-plugins',
        keyring,
      }),
    ).toThrow();

    // Tampered file → hash mismatch.
    const tampered = new Map(files);
    tampered.set('dist/index.js', new TextEncoder().encode('export default { evil: true }'));
    expect(() =>
      verifyPackageSignatureBound({
        files: tampered,
        keyId: 'pkg-stackpanel',
        expectedPublisher: 'stackpanel',
        expectedRepository: 'worable233/stackpanel-plugins',
        keyring,
      }),
    ).toThrow();
  });

  it('rejects a malformed signature.json', () => {
    expect(() => parsePackageSignatureFile(new TextEncoder().encode('nope'))).toThrow();
    expect(() =>
      parsePackageSignatureFile(new TextEncoder().encode(JSON.stringify({ algorithm: 'rsa' }))),
    ).toThrow();
  });
});

describe('github source fetch', () => {
  it('honours ETag caching (304 returns cached body)', async () => {
    const cache = new MemorySourceCache();
    const fetchImpl = vi.fn(async () => {
      return new Response('{"ok":true}', {
        status: 200,
        headers: { etag: 'W/"abc"', 'content-type': 'application/json' },
      });
    });
    const first = await fetchTextConditional('https://api.github.com/x', cache, { fetchImpl });
    expect(first.fromCache).toBe(false);
    expect(first.body).toBe('{"ok":true}');

    const fetch304 = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(null, { status: 304 }),
    );
    const second = await fetchTextConditional('https://api.github.com/x', cache, {
      fetchImpl: fetch304,
    });
    expect(second.fromCache).toBe(true);
    expect(second.body).toBe('{"ok":true}');
    // conditional headers were sent
    const init = fetch304.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('if-none-match')).toBe('W/"abc"');
  });

  it('keeps cached body when GitHub is unreachable', async () => {
    const cache = new MemorySourceCache();
    await fetchTextConditional('https://api.github.com/y', cache, {
      fetchImpl: async () => new Response('cached', { status: 200 }),
    });
    const result = await fetchTextConditional('https://api.github.com/y', cache, {
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    expect(result.fromCache).toBe(true);
    expect(result.body).toBe('cached');
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('0')).toBe(0);
    const now = () => new Date('2026-10-16T00:00:00Z');
    expect(parseRetryAfter('Fri, 16 Oct 2026 00:00:10 GMT', now)).toBe(10_000);
  });

  it('rejects a redirect to a host outside the allowlist', async () => {
    await expect(
      fetchTextConditional('https://api.github.com/z', new MemorySourceCache(), {
        fetchImpl: async () =>
          new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
      }),
    ).rejects.toThrow(/允许域名/);
  });

  it('follows an allowed redirect and strips the token cross-origin', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (url === 'https://api.github.com/a') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://objects.githubusercontent.com/b' },
        });
      }
      return new Response('asset', { status: 200 });
    });
    const result = await fetchTextConditional('https://api.github.com/a', new MemorySourceCache(), {
      fetchImpl,
      token: 'secret',
    });
    expect(result.body).toBe('asset');
    expect(seen[0]?.auth).toBe('Bearer secret');
    expect(seen[1]?.url).toBe('https://objects.githubusercontent.com/b');
    expect(seen[1]?.auth).toBeNull();
  });

  it('streams a download and computes the sha256', async () => {
    const bytes = new TextEncoder().encode('hello-distribution');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const result = await downloadAsset('https://objects.githubusercontent.com/asset', {
      fetchImpl: async () => new Response(bytes, { status: 200 }),
    });
    expect(result.sha256).toBe(digest);
    expect(result.size).toBe(bytes.byteLength);
  });

  it('rejects an over-size download', async () => {
    await expect(
      downloadAsset('https://objects.githubusercontent.com/big', {
        fetchImpl: async () =>
          new Response(new Uint8Array(2048), {
            status: 200,
            headers: { 'content-length': '2048' },
          }),
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/上限/);
  });
});

describe('catalog client', () => {
  function raw(url: string, tag: string, file: string): string {
    return `https://raw.githubusercontent.com/${url}/${tag}/${file}`;
  }

  it('fetches a sequenced catalog, verifies it, and maps channel pointer', async () => {
    const { publicKeyPem, privateKey } = keypair();
    const keyring: Keyring = {
      formatVersion: 1,
      keys: [
        {
          keyId: 'catalog-2026',
          purpose: 'catalog',
          publicKeyPem,
          allowedRepositories: ['worable233/stackpanel-market'],
        },
      ],
    };
    const snapshot = catalogSnapshot();
    const catalogBody = JSON.stringify(snapshot);
    const catalogBytes = new TextEncoder().encode(catalogBody);
    const signature = signCatalog(privateKey, catalogBytes);

    const cache = new MemorySourceCache();
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === raw('worable233/stackpanel-market', 'main', 'channels.json')) {
        return new Response(JSON.stringify({ channels: [{ channel: 'stable', sequence: 7 }] }));
      }
      if (url === raw('worable233/stackpanel-market', 'catalog-v1/7', 'catalog.json')) {
        return new Response(catalogBody);
      }
      if (url === raw('worable233/stackpanel-market', 'catalog-v1/7', 'catalog.sig')) {
        return new Response(JSON.stringify(signature));
      }
      return new Response('not found', { status: 404 });
    });

    const resolved = await fetchCatalogSequenced(
      { repository: 'worable233/stackpanel-market', fetchImpl },
      cache,
      keyring,
      7,
      0,
      new Date('2026-10-16T01:00:00Z'),
    );
    expect(resolved.sequence).toBe(7);
    expect(mayInstallFromCatalog(resolved)).toBe(true);
  });

  it('refuses to replay an older sequence', async () => {
    const keyring: Keyring = { formatVersion: 1, keys: [] };
    await expect(
      fetchCatalogSequenced(
        { repository: 'worable233/stackpanel-market', fetchImpl: async () => new Response('') },
        new MemorySourceCache(),
        keyring,
        6,
        7,
      ),
    ).rejects.toThrow(/回放/);
  });

  it('rejects an expired catalog for new automatic installs', async () => {
    const { publicKeyPem, privateKey } = keypair();
    const keyring: Keyring = {
      formatVersion: 1,
      keys: [
        {
          keyId: 'catalog-2026',
          purpose: 'catalog',
          publicKeyPem,
          allowedRepositories: ['worable233/stackpanel-market'],
        },
      ],
    };
    const snapshot = catalogSnapshot({ expiresAt: '2026-10-16T00:00:00.000Z' });
    const catalogBody = JSON.stringify(snapshot);
    const signature = signCatalog(privateKey, new TextEncoder().encode(catalogBody));
    const cache: SourceCache = new MemorySourceCache();
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('catalog.json')) return new Response(catalogBody);
      if (url.endsWith('catalog.sig')) return new Response(JSON.stringify(signature));
      return new Response('not found', { status: 404 });
    };
    const resolved = await fetchCatalogSequenced(
      { repository: 'worable233/stackpanel-market', fetchImpl },
      cache,
      keyring,
      8,
      0,
      new Date('2026-10-20T00:00:00Z'),
    );
    expect(resolved.expired).toBe(true);
    expect(mayInstallFromCatalog(resolved)).toBe(false);
  });

  it('rejects a catalog whose signature does not match the bytes', async () => {
    const { publicKeyPem, privateKey } = keypair();
    const keyring: Keyring = {
      formatVersion: 1,
      keys: [
        {
          keyId: 'catalog-2026',
          purpose: 'catalog',
          publicKeyPem,
          allowedRepositories: ['worable233/stackpanel-market'],
        },
      ],
    };
    const goodBody = JSON.stringify(catalogSnapshot());
    const signature = signCatalog(privateKey, new TextEncoder().encode(goodBody));
    // Serve a *different* catalog with the good signature.
    const tampered = JSON.stringify(catalogSnapshot({ sequence: 9 }));
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('catalog.json')) return new Response(tampered);
      if (url.endsWith('catalog.sig')) return new Response(JSON.stringify(signature));
      return new Response('not found', { status: 404 });
    };
    await expect(
      fetchCatalogSequenced(
        { repository: 'worable233/stackpanel-market', fetchImpl },
        new MemorySourceCache(),
        keyring,
        9,
        0,
      ),
    ).rejects.toThrow(/签名/);
  });
});
