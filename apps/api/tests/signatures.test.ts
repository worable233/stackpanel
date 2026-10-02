import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  packageFileHashes,
  SignatureError,
  verifyPackageSignature,
} from '../src/lib/signatures.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signedFiles(overrides: Record<string, string> = {}): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify({ id: 'demo' })));
  files.set('dist/index.js', new TextEncoder().encode('export default {};'));
  for (const [name, value] of Object.entries(overrides)) {
    files.set(name, new TextEncoder().encode(value));
  }
  return files;
}

function attachSignature(files: Map<string, Uint8Array>): void {
  const hashes = packageFileHashes(files);
  const payload = Buffer.from(JSON.stringify({ algorithm: 'ed25519', files: hashes }), 'utf8');
  const signature = sign(null, payload, privateKey).toString('base64');
  files.set(
    'signature.json',
    new TextEncoder().encode(JSON.stringify({ algorithm: 'ed25519', files: hashes, signature })),
  );
}

describe('package signature verification', () => {
  it('verifies a correctly signed package', () => {
    const files = signedFiles();
    attachSignature(files);
    expect(() => verifyPackageSignature(files, publicKeyPem)).not.toThrow();
  });

  it('rejects a tampered package', () => {
    const files = signedFiles();
    attachSignature(files);
    files.set('manifest.json', new TextEncoder().encode('tampered'));
    expect(() => verifyPackageSignature(files, publicKeyPem)).toThrow(SignatureError);
  });

  it('requires signature.json when a public key is configured', () => {
    expect(() => verifyPackageSignature(signedFiles(), publicKeyPem)).toThrow(
      '缺少 signature.json',
    );
  });

  it('skips verification in development mode without a public key', () => {
    expect(() => verifyPackageSignature(signedFiles(), undefined)).not.toThrow();
  });

  it('requires a configured key when the signing policy is enforced', () => {
    expect(() => verifyPackageSignature(signedFiles(), undefined, true)).toThrow(
      '已启用签名强制校验',
    );
  });
});
