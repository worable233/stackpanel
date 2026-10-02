/**
 * Reseller key material (SP-V1).
 *
 * Each reseller uses two Ed25519 key pairs:
 *
 *   - **Inbound** (partner → platform): the operator hands the partner a private
 *     key once; the platform stores only the public key and verifies signatures.
 *   - **Outbound** (platform → partner, webhook): the platform generates the pair,
 *     hands the partner the public key, and stores the private key **encrypted**
 *     with the kernel `SETTINGS_ENCRYPTION_KEY` (same AES-256-GCM facility as
 *     plugin secrets). Signing webhooks therefore requires the encryption key to
 *     be configured; without it, reseller creation fails loudly rather than
 *     persisting a private key in the clear.
 */
import { generateKeyPairSync } from 'node:crypto';
import { decryptSecret, encryptSecret, isSecretsEnabled } from '../lib/crypto.ts';

export interface Ed25519KeyPair {
  publicKey: string;
  privateKey: string;
}

/** Generate a fresh Ed25519 key pair in PEM (SPKI public / PKCS8 private). */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Encrypt a private key for at-rest storage. Throws when secrets are disabled. */
export function protectPrivateKey(privateKeyPem: string): string {
  if (!isSecretsEnabled()) {
    throw new Error('未配置 SETTINGS_ENCRYPTION_KEY，无法安全保存回调签名私钥');
  }
  return encryptSecret(privateKeyPem);
}

/** Decrypt a stored private key; null when absent or unreadable. */
export function revealPrivateKey(stored: string | null): string | null {
  if (!stored) return null;
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}
