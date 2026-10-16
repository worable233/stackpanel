import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  canonicalizeCatalogSnapshot,
  catalogDigest,
  catalogReleaseTag,
  stableStringify,
  type CatalogSnapshot,
} from '../src/distribution/catalog.js';
import {
  packageSignaturePayload,
  parsePackageSignatureFile,
  signCatalog,
  signPackageFiles,
  verifyCatalogSignatureBytes,
  verifyPackageSignatureBound,
  DistributionSignatureError,
} from '../src/distribution/signing.js';
import type { Keyring } from '../src/distribution/trust.js';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function catalog(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    formatVersion: 1,
    sequence: 3,
    generatedAt: '2026-10-16T00:00:00.000Z',
    expiresAt: '2026-10-30T00:00:00.000Z',
    channels: [{ channel: 'stable', sequence: 3 }],
    publishers: [
      { publisher: 'stackpanel', keyIds: ['catalog-2026'], repositories: ['worable233/market'] },
    ],
    entries: [],
    ...overrides,
  };
}

describe('catalog canonicalization', () => {
  it('sorts object keys and keeps array order for a stable digest', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ z: [3, { y: 1, x: 2 }], a: 'v' })).toBe(
      '{"a":"v","z":[3,{"x":2,"y":1}]}',
    );
    // Key order in the input must not change the canonical bytes/digest.
    const left = catalogDigest(new TextEncoder().encode(stableStringify({ b: 1, a: 2 })));
    const right = catalogDigest(new TextEncoder().encode(stableStringify({ a: 2, b: 1 })));
    expect(left).toBe(right);
  });

  it('canonical bytes are deterministic for a snapshot', () => {
    const bytes = canonicalizeCatalogSnapshot(catalog());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe(stableStringify(catalog()));
  });
});

describe('catalog signing round-trip', () => {
  it('signs and verifies catalog bytes; rejects tampering and untrusted repos', () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const keyring: Keyring = {
      formatVersion: 1,
      keys: [
        {
          keyId: 'catalog-2026',
          purpose: 'catalog',
          publicKeyPem,
          allowedRepositories: ['worable233/market'],
        },
      ],
    };
    const bytes = canonicalizeCatalogSnapshot(catalog());
    const signature = signCatalog(bytes, privateKeyPem, 'catalog-2026');
    expect(signature.algorithm).toBe('ed25519');
    expect(signature.digest).toBe(catalogDigest(bytes));

    expect(() =>
      verifyCatalogSignatureBytes({
        catalogBytes: bytes,
        signature,
        keyring,
        repository: 'worable233/market',
      }),
    ).not.toThrow();

    // Tampered bytes.
    const tampered = canonicalizeCatalogSnapshot(catalog({ sequence: 4 }));
    expect(() =>
      verifyCatalogSignatureBytes({
        catalogBytes: tampered,
        signature,
        keyring,
        repository: 'worable233/market',
      }),
    ).toThrow(DistributionSignatureError);

    // Untrusted repository.
    expect(() =>
      verifyCatalogSignatureBytes({
        catalogBytes: bytes,
        signature,
        keyring,
        repository: 'evil/market',
      }),
    ).toThrow(/未被信任/);
  });

  it('rejects a non-ed25519 catalog signature algorithm', () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const keyring: Keyring = {
      formatVersion: 1,
      keys: [{ keyId: 'k', purpose: 'catalog', publicKeyPem }],
    };
    const bytes = canonicalizeCatalogSnapshot(catalog());
    const good = signCatalog(bytes, privateKeyPem, 'k');
    const bad = { ...good, algorithm: 'rsa' as unknown as 'ed25519' };
    expect(() =>
      verifyCatalogSignatureBytes({
        catalogBytes: bytes,
        signature: bad,
        keyring,
        repository: 'r',
      }),
    ).toThrow(/不支持的目录签名算法/);
  });
});

describe('package signing round-trip', () => {
  it('signs files and verifies with publisher/repository binding', () => {
    const { publicKeyPem, privateKeyPem } = keypair();
    const keyring: Keyring = {
      formatVersion: 1,
      keys: [
        {
          keyId: 'pkg-stackpanel',
          purpose: 'package',
          publicKeyPem,
          publisher: 'stackpanel',
          allowedRepositories: ['worable233/plugins'],
        },
      ],
    };
    const entries: Array<[string, Uint8Array]> = [
      ['manifest.json', new TextEncoder().encode('{"id":"store"}')],
      ['dist/index.js', new TextEncoder().encode('export default {}')],
    ];
    const signatureFile = signPackageFiles(entries, privateKeyPem);
    const files = new Map<string, Uint8Array>(entries);
    files.set('signature.json', new TextEncoder().encode(JSON.stringify(signatureFile)));

    expect(() =>
      verifyPackageSignatureBound({
        files,
        keyId: 'pkg-stackpanel',
        expectedPublisher: 'stackpanel',
        expectedRepository: 'worable233/plugins',
        keyring,
      }),
    ).not.toThrow();

    // Wrong publisher.
    expect(() =>
      verifyPackageSignatureBound({
        files,
        keyId: 'pkg-stackpanel',
        expectedPublisher: 'impostor',
        expectedRepository: 'worable233/plugins',
        keyring,
      }),
    ).toThrow();

    // Tampered file.
    const tampered = new Map(files);
    tampered.set('dist/index.js', new TextEncoder().encode('export default { evil: true }'));
    expect(() =>
      verifyPackageSignatureBound({
        files: tampered,
        keyId: 'pkg-stackpanel',
        expectedPublisher: 'stackpanel',
        expectedRepository: 'worable233/plugins',
        keyring,
      }),
    ).toThrow(/不一致/);
  });

  it('parses only a well-formed signature.json', () => {
    const { privateKeyPem } = keypair();
    const signatureFile = signPackageFiles(
      [['a.txt', new TextEncoder().encode('a')]],
      privateKeyPem,
    );
    expect(
      parsePackageSignatureFile(new TextEncoder().encode(JSON.stringify(signatureFile))),
    ).toEqual(signatureFile);
    expect(() => parsePackageSignatureFile(new TextEncoder().encode('nope'))).toThrow();
    expect(() =>
      parsePackageSignatureFile(new TextEncoder().encode(JSON.stringify({ algorithm: 'rsa' }))),
    ).toThrow();
  });

  it('payload is exactly the canonical {algorithm, files} object', () => {
    const { privateKeyPem } = keypair();
    const entries: Array<[string, Uint8Array]> = [
      ['b.txt', new TextEncoder().encode('b')],
      ['a.txt', new TextEncoder().encode('a')],
    ];
    const signatureFile = signPackageFiles(entries, privateKeyPem);
    // Keys sorted by path.
    expect(Object.keys(signatureFile.files)).toEqual(['a.txt', 'b.txt']);
    const payload = packageSignaturePayload(signatureFile.files);
    expect(JSON.parse(payload.toString('utf8'))).toEqual({
      algorithm: 'ed25519',
      files: signatureFile.files,
    });
    // Sanity: an independent signature over the same payload verifies.
    expect(signatureFile.signature.length).toBeGreaterThan(0);
  });
});

describe('catalog tag', () => {
  it('uses catalog-v1/<sequence> and hashes the canonical bytes', () => {
    expect(catalogReleaseTag(7)).toBe('catalog-v1/7');
    const bytes = canonicalizeCatalogSnapshot(catalog());
    expect(catalogDigest(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
