import { createHash, createPublicKey } from 'node:crypto';
import type { Prisma } from '@stackpanel/db';
import { env } from '../config/env.ts';
import { getPrisma } from '../plugins/prisma.ts';

const SIGNING_KEY_SETTING = 'signing.publicKey';

export interface SigningStatus {
  source: 'env' | 'stored' | 'disabled';
  configured: boolean;
  fingerprint: string | null;
  publicKey: string | null;
}

/** Validate an Ed25519 public key before persisting it. */
export function isValidSigningPublicKey(publicKey: string): boolean {
  try {
    return createPublicKey(publicKey).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

/** Resolve the active signing public key: env wins, then stored admin setting. */
export async function readSigningPublicKey(): Promise<string | undefined> {
  if (env.STACKPANEL_SIGNING_PUBLIC_KEY) return env.STACKPANEL_SIGNING_PUBLIC_KEY;
  const row = await getPrisma().setting.findUnique({ where: { key: SIGNING_KEY_SETTING } });
  return storedKey(row?.value);
}

/** Return the signing policy status for admin UI. */
export async function getSigningStatus(): Promise<SigningStatus> {
  if (env.STACKPANEL_SIGNING_PUBLIC_KEY) {
    return {
      source: 'env',
      configured: true,
      fingerprint: fingerprint(env.STACKPANEL_SIGNING_PUBLIC_KEY),
      publicKey: env.STACKPANEL_SIGNING_PUBLIC_KEY,
    };
  }
  const row = await getPrisma().setting.findUnique({ where: { key: SIGNING_KEY_SETTING } });
  const publicKey = storedKey(row?.value);
  if (!publicKey) {
    return { source: 'disabled', configured: false, fingerprint: null, publicKey: null };
  }
  return {
    source: 'stored',
    configured: true,
    fingerprint: fingerprint(publicKey),
    publicKey,
  };
}

/** Persist or clear the admin-managed signing public key. */
export async function setStoredSigningPublicKey(
  publicKey: string,
  updatedBy: string | null,
): Promise<void> {
  const normalized = publicKey.trim();
  const prisma = getPrisma();
  if (normalized.length === 0) {
    await prisma.setting.deleteMany({ where: { key: SIGNING_KEY_SETTING } });
    return;
  }
  if (!isValidSigningPublicKey(normalized)) {
    throw new Error('Ed25519 公钥无效');
  }
  await prisma.setting.upsert({
    where: { key: SIGNING_KEY_SETTING },
    create: {
      key: SIGNING_KEY_SETTING,
      value: { publicKey: normalized } as Prisma.InputJsonValue,
      updatedBy,
    },
    update: {
      value: { publicKey: normalized } as Prisma.InputJsonValue,
      updatedBy,
    },
  });
}

function storedKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as { publicKey?: unknown }).publicKey;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function fingerprint(publicKey: string): string {
  return createHash('sha256').update(publicKey.trim()).digest('hex').slice(0, 16);
}
