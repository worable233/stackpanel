/**
 * Channel partner key material (moved out of the kernel under ADR-0021 §D4).
 *
 * Each partner uses two Ed25519 key pairs:
 *
 *   - **Inbound** (partner → platform): the operator hands the partner a private
 *     key once; the platform stores only the public key and verifies signatures.
 *   - **Outbound** (platform → partner, webhook): the platform generates the pair,
 *     hands the partner the public key, and stores the private key in the kernel
 *     secret store (`ctx.secrets`) — never in plugin data. Signing webhooks
 *     therefore requires secret storage to be configured; without it, partner
 *     creation with a callback URL fails loudly rather than persisting a private
 *     key in the clear.
 */
import { generateKeyPairSync } from 'node:crypto';
import { secretStore } from './context';
import { ChannelError } from './errors';

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

/** Secret-store key holding a partner's outbound (webhook) signing private key. */
export function webhookSecretRef(partnerId: string): string {
  // Must satisfy the kernel secret-key charset (no ':').
  return `webhook-key.${partnerId}`;
}

/**
 * Persist a partner's webhook private key in the secret store and return the
 * opaque ref stored on the model. Throws when secret storage is unavailable.
 */
export async function protectWebhookPrivateKey(
  partnerId: string,
  privateKeyPem: string,
): Promise<string> {
  const secrets = secretStore();
  if (!secrets.isAvailable()) {
    throw new ChannelError(409, '未配置 SETTINGS_ENCRYPTION_KEY，无法安全保存回调签名私钥');
  }
  const ref = webhookSecretRef(partnerId);
  await secrets.set(ref, privateKeyPem);
  return ref;
}

/** Remove a partner's stored webhook private key (best-effort). */
export async function forgetWebhookPrivateKey(ref: string | null): Promise<void> {
  if (!ref) return;
  await secretStore().remove(ref).catch(() => undefined);
}

/** Reveal a partner's webhook private key by ref; null when absent/unreadable. */
export async function revealWebhookPrivateKey(ref: string | null): Promise<string | null> {
  if (!ref) return null;
  try {
    return await secretStore().get(ref);
  } catch {
    return null;
  }
}
