import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.ts';
import { secretsPolicy } from './secrets-policy.ts';
import type { PrismaClient } from '@stackpanel/db';
import type { PluginSecrets } from '@stackpanel/sdk';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Whether secret storage is enabled (requires SETTINGS_ENCRYPTION_KEY). The
 * single source of truth for the enabled/disabled decision is
 * {@link secretsPolicy} (CONTRACT-SEC / H3): unset or blank ⇒ disabled.
 */
export function isSecretsEnabled(): boolean {
  return secretsPolicy(env.SETTINGS_ENCRYPTION_KEY).enabled;
}

/** Derive a fixed 32-byte key from the env secret via SHA-256. */
function keyBuffer(): Buffer {
  const key = env.SETTINGS_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('未配置 SETTINGS_ENCRYPTION_KEY');
  }
  return createHash('sha256').update(key).digest();
}

/**
 * Encrypt a string with AES-256-GCM. Format: iv.tag.ciphertext (base64).
 * A random IV and auth tag make ciphertexts non-deterministic and tamper-evident.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuffer(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString('base64')).join('.');
}

/** Decrypt a value produced by {@link encryptSecret}, verifying its auth tag. */
export function decryptSecret(stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('密钥数据损坏');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('密钥数据损坏');
  }
  const decipher = createDecipheriv(ALGORITHM, keyBuffer(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

const PLUGIN_SECRET_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Provide a plugin with an encrypted, namespaced secret store. The namespace
 * is enforced by the kernel, so a plugin cannot read another plugin's secrets.
 */
export function pluginSecrets(prisma: PrismaClient, pluginId: string): PluginSecrets {
  const prefix = `plugin.${pluginId}.`;
  const keyFor = (key: string): string => {
    if (!PLUGIN_SECRET_KEY.test(key)) throw new Error('非法的密钥名');
    return `${prefix}${key}`;
  };

  return {
    isAvailable: isSecretsEnabled,
    async get(key) {
      if (!isSecretsEnabled()) return null;
      const stored = await prisma.secret.findUnique({ where: { key: keyFor(key) } });
      return stored ? decryptSecret(stored.ciphertext) : null;
    },
    async set(key, value) {
      if (!isSecretsEnabled()) throw new Error('加密密钥存储未配置');
      await prisma.secret.upsert({
        where: { key: keyFor(key) },
        create: { key: keyFor(key), ciphertext: encryptSecret(value) },
        update: { ciphertext: encryptSecret(value) },
      });
    },
    async remove(key) {
      if (!isSecretsEnabled()) return;
      await prisma.secret.deleteMany({ where: { key: keyFor(key) } });
    },
  };
}
