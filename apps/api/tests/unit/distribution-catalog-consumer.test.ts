import { describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { zipSync } from 'fflate';
import {
  CatalogConsumerError,
  catalogCandidateSources,
  fetchCatalogPackage,
  resolvePublisherBinding,
  resolveUsableKeyId,
} from '../../src/distribution/catalog-consumer.ts';
import { MemorySourceCache } from '../../src/distribution/github-source.ts';
import { signPackageFiles } from '@stackpanel/spec';
import type { CatalogEntry, CatalogSnapshot, Keyring } from '@stackpanel/spec';

const REPO = 'worable233/stackpanel-plugins';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function manifest(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    formatVersion: 1,
    kind: 'plugin',
    id: 'store',
    version: '1.0.0',
    channel: 'stable',
    source: { repository: REPO, tag: 'store-v1.0.0', asset: 'store-1.0.0.zip' },
    artifact: { sha256: 'a'.repeat(64), size: 100 },
    compatibility: {
      kernel: '>=0.2.0 <0.3.0',
      kernelApi: '1',
      frontendAbi: '1',
      packageFormat: 1,
    },
    requires: [],
    conflicts: [],
    permissions: [],
    frontendModes: ['M2'],
    migration: { mode: 'none', rollback: 'code-compatible' },
    automatic: { eligible: true },
    publisher: 'stackpanel',
    ...overrides,
  };
}

function catalog(entries: CatalogEntry[]): CatalogSnapshot {
  return {
    formatVersion: 1,
    sequence: 7,
    generatedAt: '2026-10-16T00:00:00.000Z',
    expiresAt: '2026-10-30T00:00:00.000Z',
    channels: [{ channel: 'stable', sequence: 7 }],
    publishers: [{ publisher: 'stackpanel', keyIds: ['pkg-1'], repositories: [REPO] }],
    entries,
  };
}

function keyring(overrides: Partial<Keyring['keys'][number]> = {}): Keyring {
  return {
    formatVersion: 1,
    keys: [
      {
        keyId: 'pkg-1',
        purpose: 'package',
        publicKeyPem: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
        publisher: 'stackpanel',
        allowedRepositories: [REPO],
        ...overrides,
      },
    ],
  };
}

describe('catalogCandidateSources', () => {
  it('groups by (kind,id), drops revoked entries, and sorts deterministically', () => {
    const sources = catalogCandidateSources(
      catalog([
        manifest({ version: '1.0.0' }),
        manifest({ version: '1.2.0' }),
        manifest({ version: '1.1.0' }),
        manifest({ version: '0.9.0', revoked: true }),
        manifest({ kind: 'theme', id: 'ocean', version: '2.0.0' }),
      ]),
    );
    const store = sources.find((s) => s.id === 'store');
    expect(store?.manifests.map((m) => m.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    // Revoked 0.9.0 is not a candidate.
    expect(store?.manifests.some((m) => m.version === '0.9.0')).toBe(false);
    expect(sources.map((s) => s.id)).toEqual(['store', 'ocean']);
  });
});

describe('resolvePublisherBinding', () => {
  it('binds an entry to its publisher keyId when the repository matches', () => {
    const binding = resolvePublisherBinding(catalog([]), manifest());
    expect(binding).toEqual({ publisher: 'stackpanel', keyId: 'pkg-1' });
  });

  it('rejects an entry whose publisher is not in the catalog whitelist', () => {
    expect(() => resolvePublisherBinding(catalog([]), manifest({ publisher: 'evil' }))).toThrow(
      /不在目录信任白名单/,
    );
  });

  it('rejects an entry whose source repository is not owned by the publisher', () => {
    const entry = manifest({
      source: { repository: 'evil/plugins', tag: 'x', asset: 'x.zip' },
    });
    expect(() => resolvePublisherBinding(catalog([]), entry)).toThrow(/不属于发布者/);
  });

  it('rejects an entry with no publisher binding', () => {
    const entry = manifest();
    delete entry.publisher;
    expect(() => resolvePublisherBinding(catalog([]), entry)).toThrow(CatalogConsumerError);
  });
});

describe('resolveUsableKeyId', () => {
  const binding = { publisher: 'stackpanel', keyId: 'pkg-1' };

  it('accepts a package key that allows the source repository', () => {
    expect(resolveUsableKeyId(keyring(), binding, manifest())).toBe('pkg-1');
  });

  it('rejects a key the catalog declares but the keyring does not trust', () => {
    const kr: Keyring = { formatVersion: 1, keys: [] };
    expect(() => resolveUsableKeyId(kr, binding, manifest())).toThrow(/信任根缺少 keyId/);
  });

  it('rejects a catalog-purpose key used for package signing', () => {
    expect(() => resolveUsableKeyId(keyring({ purpose: 'catalog' }), binding, manifest())).toThrow(
      /用途不是 package/,
    );
  });

  it('rejects a revoked or expired key', () => {
    expect(() => resolveUsableKeyId(keyring({ revoked: true }), binding, manifest())).toThrow(
      /已撤销/,
    );
    expect(() =>
      resolveUsableKeyId(keyring({ notAfter: '2020-01-01T00:00:00Z' }), binding, manifest()),
    ).toThrow(/已过期/);
  });

  it('rejects a key whose declared publisher differs from the catalog binding', () => {
    expect(() =>
      resolveUsableKeyId(keyring({ publisher: 'someone-else' }), binding, manifest()),
    ).toThrow(/发布者.*不符/);
  });

  it('rejects a key that does not allow the source repository', () => {
    expect(() =>
      resolveUsableKeyId(keyring({ allowedRepositories: ['other/repo'] }), binding, manifest()),
    ).toThrow(/不允许来源仓库/);
  });
});

describe('fetchCatalogPackage', () => {
  it('resolves the publisher binding, verifies the key, and returns unpacked files', async () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const entries: Array<[string, Uint8Array]> = [
      ['manifest.json', new TextEncoder().encode('{"id":"store","version":"1.2.0"}')],
      ['dist/index.js', new TextEncoder().encode('export default {}')],
    ];
    const signatureFile = signPackageFiles(entries, privateKeyPem);
    const record: Record<string, Uint8Array> = {};
    for (const [name, data] of entries) record[name] = data;
    record['signature.json'] = new TextEncoder().encode(JSON.stringify(signatureFile));
    const zip = zipSync(record);
    const sha256 = createHash('sha256').update(zip).digest('hex');
    const entry = manifest({
      version: '1.2.0',
      artifact: { sha256, size: zip.byteLength },
      source: { repository: REPO, tag: 'store-v1.2.0', asset: 'store-1.2.0.zip' },
    });

    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/repos/')) {
        return new Response(
          JSON.stringify({
            assets: [
              {
                name: 'store-1.2.0.zip',
                size: zip.byteLength,
                browser_download_url: 'https://objects.githubusercontent.com/store',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(zip, { status: 200 });
    });

    const result = await fetchCatalogPackage({
      catalog: catalog([entry]),
      entry,
      keyring: keyring({ publicKeyPem }),
      cache: new MemorySourceCache(),
      fetchImpl,
    });
    expect(result.publisher).toBe('stackpanel');
    expect(result.keyId).toBe('pkg-1');
    expect(result.sha256).toBe(sha256);
    expect(result.files.has('dist/index.js')).toBe(true);
  });

  it('refuses to download when the catalog publisher is not whitelisted', async () => {
    const entry = manifest({ publisher: 'evil' });
    const fetchImpl = vi.fn();
    await expect(
      fetchCatalogPackage({
        catalog: catalog([entry]),
        entry,
        keyring: keyring(),
        cache: new MemorySourceCache(),
        fetchImpl,
      }),
    ).rejects.toThrow(/不在目录信任白名单/);
    // No network request is attempted before trust is established.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
