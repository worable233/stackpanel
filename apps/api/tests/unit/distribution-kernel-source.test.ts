import { describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { fetchAndVerifyKernelManifest } from '../../src/distribution/kernel-source.ts';
import { MemorySourceCache } from '../../src/distribution/github-source.ts';
import { kernelManifestBytes, signKernelManifest } from '@stackpanel/spec';
import type { CatalogKernelRef, KernelManifest, Keyring } from '@stackpanel/spec';

const REPO = 'worable233/stackpanel';
const KEY_ID = 'kernel-reh';

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
        keyId: KEY_ID,
        purpose: 'kernel',
        publicKeyPem,
        allowedRepositories: [REPO],
      },
    ],
  };
}

function kernelManifest(): KernelManifest {
  return {
    formatVersion: 1,
    kind: 'kernel',
    version: '0.3.0',
    channel: 'stable',
    kernelApi: '0.4.0',
    frontendAbi: '1.0.0',
    updateProtocol: 1,
    upgradeFrom: '>=0.1.0',
    migrationPath: 'direct',
    schemaRange: '*',
    images: [{ platform: 'linux/amd64', digest: `ghcr.io/${REPO}@sha256:${'a'.repeat(64)}` }],
    corePackages: [],
    supportedPlatforms: ['linux/amd64'],
    smokeProbeVersion: 1,
    databaseMigration: '20261010000000_kernel_0_3_0',
  };
}

/** Signed manifest + matching catalog ref (digest of the exact published bytes). */
function buildSignedKernel(privateKeyPem: string) {
  const manifest = kernelManifest();
  const bytes = kernelManifestBytes(manifest);
  const signature = signKernelManifest(bytes, privateKeyPem, KEY_ID);
  const signatureBytes = new TextEncoder().encode(JSON.stringify(signature));
  const ref: CatalogKernelRef = {
    version: manifest.version,
    channel: 'stable',
    source: { repository: REPO, tag: 'v0.3.0', asset: 'kernel-manifest.json' },
    digest: createHash('sha256').update(bytes).digest('hex'),
    keyId: KEY_ID,
  };
  return { manifest, bytes, signatureBytes, ref };
}

/** fetch that serves the release asset listing plus the two asset bodies. */
function fetchFor(
  ref: CatalogKernelRef,
  bodies: { manifest: Uint8Array; signature: Uint8Array },
  opts: { renameSignature?: string | null } = {},
) {
  const signatureName =
    opts.renameSignature === undefined ? 'kernel-manifest.sig' : opts.renameSignature;
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/repos/')) {
      const assets = [
        {
          name: ref.source.asset,
          size: bodies.manifest.byteLength,
          browser_download_url: 'https://objects.githubusercontent.com/manifest',
        },
      ];
      if (signatureName) {
        assets.push({
          name: signatureName,
          size: bodies.signature.byteLength,
          browser_download_url: 'https://objects.githubusercontent.com/signature',
        });
      }
      return new Response(JSON.stringify({ assets }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://objects.githubusercontent.com/manifest') {
      return new Response(bodies.manifest, { status: 200 });
    }
    if (url === 'https://objects.githubusercontent.com/signature') {
      return new Response(bodies.signature, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

describe('fetchAndVerifyKernelManifest', () => {
  it('downloads, checks the catalog digest and verifies the kernel signature', async () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const { bytes, signatureBytes, ref } = buildSignedKernel(privateKeyPem);
    const result = await fetchAndVerifyKernelManifest({
      ref,
      cache: new MemorySourceCache(),
      keyring: keyring(publicKeyPem),
      fetchImpl: fetchFor(ref, { manifest: bytes, signature: signatureBytes }),
    });
    expect(result.manifest.version).toBe('0.3.0');
    expect(result.sha256).toBe(ref.digest);
    expect(result.keyId).toBe(KEY_ID);
  });

  it('rejects when the manifest bytes do not match the catalog digest', async () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const { signatureBytes, ref } = buildSignedKernel(privateKeyPem);
    const tampered = kernelManifestBytes({ ...kernelManifest(), version: '9.9.9' });
    await expect(
      fetchAndVerifyKernelManifest({
        ref,
        cache: new MemorySourceCache(),
        keyring: keyring(publicKeyPem),
        fetchImpl: fetchFor(ref, { manifest: tampered, signature: signatureBytes }),
      }),
    ).rejects.toThrow(/SHA-256/);
  });

  it('rejects a signature that does not match the referenced keyId', async () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const { bytes, signatureBytes, ref } = buildSignedKernel(privateKeyPem);
    // Signature is valid for KEY_ID but the catalog references a different signed key.
    await expect(
      fetchAndVerifyKernelManifest({
        ref: { ...ref, keyId: 'other-key' },
        cache: new MemorySourceCache(),
        keyring: keyring(publicKeyPem),
        fetchImpl: fetchFor(ref, { manifest: bytes, signature: signatureBytes }),
      }),
    ).rejects.toThrow(/不符/);
  });

  it('rejects when the signature asset is missing from the release', async () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const { bytes, signatureBytes, ref } = buildSignedKernel(privateKeyPem);
    await expect(
      fetchAndVerifyKernelManifest({
        ref,
        cache: new MemorySourceCache(),
        keyring: keyring(publicKeyPem),
        fetchImpl: fetchFor(
          ref,
          { manifest: bytes, signature: signatureBytes },
          { renameSignature: null },
        ),
      }),
    ).rejects.toThrow(/找不到资产/);
  });
});
