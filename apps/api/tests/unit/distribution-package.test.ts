import { describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { zipSync } from 'fflate';
import {
  fetchAndVerifyPackage,
  resolveReleaseAssetUrl,
  unpackArchive,
} from '../../src/distribution/package-source.ts';
import { MemorySourceCache } from '../../src/distribution/github-source.ts';
import { signPackageFiles } from '@stackpanel/spec';
import type { Keyring, PackageManifest } from '@stackpanel/spec';

const REPO = 'worable233/stackpanel-plugins';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function keyring(publicKeyPem: string): Keyring {
  return {
    formatVersion: 1,
    keys: [
      {
        keyId: 'pkg-reh',
        purpose: 'package',
        publicKeyPem,
        publisher: 'stackpanel',
        allowedRepositories: [REPO],
      },
    ],
  };
}

/** Build a signed package zip + matching manifest. */
function buildSignedPackage(privateKeyPem: string, tamperSignature = false) {
  const entries: Array<[string, Uint8Array]> = [
    ['manifest.json', new TextEncoder().encode('{"id":"demo","version":"1.0.0"}')],
    ['dist/index.js', new TextEncoder().encode('export default {}')],
  ];
  const signatureFile = signPackageFiles(entries, privateKeyPem);
  if (tamperSignature) {
    signatureFile.signature = Buffer.from('not-a-real-signature-aaaaaaaaaaaa').toString('base64');
  }
  const record: Record<string, Uint8Array> = {};
  for (const [name, data] of entries) record[name] = data;
  record['signature.json'] = new TextEncoder().encode(JSON.stringify(signatureFile));
  const zip = zipSync(record);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const manifest: PackageManifest = {
    formatVersion: 1,
    kind: 'plugin',
    id: 'demo',
    version: '1.0.0',
    channel: 'stable',
    source: { repository: REPO, tag: 'plugin-demo-v1.0.0', asset: 'demo-1.0.0.zip' },
    artifact: { sha256, size: zip.byteLength },
    compatibility: {
      kernel: '>=0.2.0 <0.3.0',
      kernelApi: '^0.4.0',
      frontendAbi: '^1.0.0',
      packageFormat: 1,
    },
    requires: [],
    conflicts: [],
    permissions: [],
    frontendModes: ['M2'],
    migration: { mode: 'none', rollback: 'code-compatible' },
    automatic: { eligible: true },
    publisher: 'stackpanel',
  };
  return { zip, manifest };
}

describe('unpackArchive', () => {
  it('rejects path traversal and oversized archives', () => {
    const evil = zipSync({ '../evil.js': new TextEncoder().encode('x') });
    expect(() => unpackArchive(evil)).toThrow(/越界路径/);
    expect(() => unpackArchive(new Uint8Array(2))).toThrow(/ZIP/);
  });
});

describe('resolveReleaseAssetUrl', () => {
  it('finds the asset by name on the tagged release', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            assets: [
              {
                name: 'demo-1.0.0.zip',
                size: 123,
                browser_download_url: 'https://objects.githubusercontent.com/a',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const resolved = await resolveReleaseAssetUrl({
      repository: REPO,
      tag: 'plugin-demo-v1.0.0',
      asset: 'demo-1.0.0.zip',
      cache: new MemorySourceCache(),
      fetchImpl,
    });
    expect(resolved.url).toBe('https://objects.githubusercontent.com/a');
    expect(resolved.size).toBe(123);
  });

  it('throws when the asset is missing', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ assets: [] }), { status: 200 });
    await expect(
      resolveReleaseAssetUrl({
        repository: REPO,
        tag: 'plugin-demo-v1.0.0',
        asset: 'nope.zip',
        cache: new MemorySourceCache(),
        fetchImpl,
      }),
    ).rejects.toThrow(/找不到资产/);
  });
});

describe('fetchAndVerifyPackage', () => {
  it('downloads, checks digest, unpacks and verifies the bound signature', async () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const { zip, manifest } = buildSignedPackage(privateKeyPem);
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/repos/')) {
        return new Response(
          JSON.stringify({
            assets: [
              {
                name: manifest.source.asset,
                size: zip.byteLength,
                browser_download_url: 'https://objects.githubusercontent.com/pkg',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(zip, { status: 200 });
    });

    const result = await fetchAndVerifyPackage({
      manifest,
      cache: new MemorySourceCache(),
      keyring: keyring(publicKeyPem),
      publisher: 'stackpanel',
      keyId: 'pkg-reh',
      fetchImpl,
    });
    expect(result.sha256).toBe(manifest.artifact.sha256);
    expect(result.files.has('dist/index.js')).toBe(true);
  });

  it('rejects a tampered signature', async () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const { zip, manifest } = buildSignedPackage(privateKeyPem, true);
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/repos/')) {
        return new Response(
          JSON.stringify({
            assets: [
              {
                name: manifest.source.asset,
                size: zip.byteLength,
                browser_download_url: 'https://objects.githubusercontent.com/pkg',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(zip, { status: 200 });
    };
    await expect(
      fetchAndVerifyPackage({
        manifest,
        cache: new MemorySourceCache(),
        keyring: keyring(publicKeyPem),
        publisher: 'stackpanel',
        keyId: 'pkg-reh',
        fetchImpl,
      }),
    ).rejects.toThrow(/签名校验失败/);
  });

  it('rejects a digest mismatch against the catalog entry', async () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const { zip, manifest } = buildSignedPackage(privateKeyPem);
    const tamperedManifest: PackageManifest = {
      ...manifest,
      artifact: { sha256: 'a'.repeat(64), size: manifest.artifact.size },
    };
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/repos/')) {
        return new Response(
          JSON.stringify({
            assets: [
              {
                name: manifest.source.asset,
                size: zip.byteLength,
                browser_download_url: 'https://objects.githubusercontent.com/pkg',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(zip, { status: 200 });
    };
    await expect(
      fetchAndVerifyPackage({
        manifest: tamperedManifest,
        cache: new MemorySourceCache(),
        keyring: keyring(publicKeyPem),
        publisher: 'stackpanel',
        keyId: 'pkg-reh',
        fetchImpl,
      }),
    ).rejects.toThrow(/SHA-256/);
  });

  it('rejects a package whose publisher key is not bound in the keyring', async () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const { zip, manifest } = buildSignedPackage(privateKeyPem);
    const fetchImpl = async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/repos/')) {
        return new Response(
          JSON.stringify({
            assets: [
              {
                name: manifest.source.asset,
                size: zip.byteLength,
                browser_download_url: 'https://objects.githubusercontent.com/pkg',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(zip, { status: 200 });
    };
    await expect(
      fetchAndVerifyPackage({
        manifest,
        cache: new MemorySourceCache(),
        keyring: keyring(publicKeyPem),
        publisher: 'impostor',
        keyId: 'pkg-reh',
        fetchImpl,
      }),
    ).rejects.toThrow(/签名校验失败/);
  });
});
