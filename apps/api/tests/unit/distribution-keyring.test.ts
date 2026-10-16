import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { parseKeyring, readStoredKeyring, KeyringError } from '../../src/distribution/keyring.ts';

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
