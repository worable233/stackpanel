import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { parseKeyring, readStoredKeyring, loadKeyring, KeyringError } from '../../src/distribution/keyring.ts';
import { env } from '../../src/config/env.ts';

function pem() {
  return generateKeyPairSync('ed25519')
    .publicKey.export({ type: 'spki', format: 'pem' })
    .toString();
}

describe('parseKeyring', () => {
  it('accepts a well-formed keyring and defaults the format version', () => {
    const keyring = parseKeyring({
      keys: [{ keyId: 'k1', purpose: 'catalog', publicKeyPem: pem() }],
    });
    expect(keyring.keys).toHaveLength(1);
    expect(keyring.formatVersion).toBe(1);
  });

  it('accepts a kernel-purpose key (needed for signed kernel manifests, §13-4)', () => {
    const keyring = parseKeyring({
      keys: [{ keyId: 'k-kernel', purpose: 'kernel', publicKeyPem: pem() }],
    });
    expect(keyring.keys[0]?.purpose).toBe('kernel');
  });

  it('rejects malformed keyrings', () => {
    expect(() => parseKeyring({})).toThrow(KeyringError);
    expect(() =>
      parseKeyring({ keys: [{ keyId: '', purpose: 'catalog', publicKeyPem: 'x' }] }),
    ).toThrow();
    expect(() =>
      parseKeyring({ keys: [{ keyId: 'k', purpose: 'root', publicKeyPem: 'x' }] }),
    ).toThrow(/purpose/);
    expect(() => parseKeyring({ keys: [{ keyId: 'k', purpose: 'package' }] })).toThrow(
      /publicKeyPem/,
    );
  });
});

describe('readStoredKeyring', () => {
  const original = process.env['STACKPANEL_DATA_DIR'];
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sp-keyring-'));
    process.env['STACKPANEL_DATA_DIR'] = dir;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env['STACKPANEL_DATA_DIR'];
    else process.env['STACKPANEL_DATA_DIR'] = original;
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the trust root is absent', async () => {
    expect(await readStoredKeyring()).toBeNull();
  });

  it('reads a valid trust root and rejects a corrupted one', async () => {
    const trustDir = path.join(dir, 'trust');
    await mkdir(trustDir, { recursive: true });
    const file = path.join(trustDir, 'keyring.json');

    await writeFile(
      file,
      JSON.stringify({
        formatVersion: 1,
        keys: [{ keyId: 'k', purpose: 'catalog', publicKeyPem: pem() }],
      }),
    );
    const keyring = await readStoredKeyring();
    expect(keyring?.keys[0]?.keyId).toBe('k');

    await writeFile(file, 'not json');
    await expect(readStoredKeyring()).rejects.toThrow(/信任根文件非法/);
  });
});

describe('loadKeyring（默认远程源的信任根）', () => {
  const original = process.env['STACKPANEL_DATA_DIR'];
  let dir: string;
  const originalRepository = env.DISTRIBUTION_CATALOG_REPOSITORY;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sp-keyring-load-'));
    process.env['STACKPANEL_DATA_DIR'] = dir;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env['STACKPANEL_DATA_DIR'];
    else process.env['STACKPANEL_DATA_DIR'] = original;
    delete env.DISTRIBUTION_CATALOG_PUBLIC_KEY;
    env.DISTRIBUTION_CATALOG_REPOSITORY = originalRepository;
    await rm(dir, { recursive: true, force: true });
  });

  it('pins an env catalog key to the configured repository and purpose=catalog', async () => {
    const key = pem();
    env.DISTRIBUTION_CATALOG_PUBLIC_KEY = key;
    env.DISTRIBUTION_CATALOG_REPOSITORY = 'acme/plugins';
    const keyring = await loadKeyring();
    const entry = keyring.keys.find((item) => item.keyId === 'env-catalog-key');
    expect(entry).toBeDefined();
    expect(entry?.purpose).toBe('catalog');
    expect(entry?.publicKeyPem).toBe(key);
    // 绑定到当前目录仓：不会顺带信任别的仓库。
    expect(entry?.allowedRepositories).toEqual(['acme/plugins']);
  });

  it('does not pin a catalog key when the catalog source is disabled', async () => {
    const key = pem();
    env.DISTRIBUTION_CATALOG_PUBLIC_KEY = key;
    env.DISTRIBUTION_CATALOG_REPOSITORY = undefined;
    const keyring = await loadKeyring();
    expect(keyring.keys.some((item) => item.keyId === 'env-catalog-key')).toBe(false);
  });

  it('never reuses the package signing key for catalog verification', async () => {
    const keyring = await loadKeyring();
    const catalogKeys = keyring.keys.filter((item) => item.purpose === 'catalog');
    const packageKeys = keyring.keys.filter((item) => item.purpose === 'package');
    expect(catalogKeys.some((item) => packageKeys.some((p) => p.keyId === item.keyId))).toBe(
      false,
    );
  });
});
