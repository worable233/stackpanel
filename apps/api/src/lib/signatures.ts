import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.ts';

const SIGNATURE_FILE = 'signature.json';

const signatureSchema = z.object({
  algorithm: z.literal('ed25519'),
  files: z.record(z.string(), z.string()),
  signature: z.string(),
});

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Verify an Ed25519 package signature. When no public key is configured the
 * check is skipped so local development remains unencumbered.
 */
export function verifyPackageSignature(
  files: Map<string, Uint8Array>,
  publicKey: string | undefined,
  required = env.PACKAGE_SIGNATURE_REQUIRED,
): void {
  if (!publicKey) {
    if (required) {
      throw new SignatureError('已启用签名强制校验，但未配置公钥');
    }
    return;
  }
  const raw = files.get(SIGNATURE_FILE);
  if (!raw) {
    throw new SignatureError('缺少 signature.json');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new SignatureError('signature.json 不是有效的 JSON');
  }
  const result = signatureSchema.safeParse(parsed);
  if (!result.success) {
    throw new SignatureError('signature.json 无效');
  }
  const signature = result.data;
  const hashes = packageFileHashes(files);
  if (JSON.stringify(hashes) !== JSON.stringify(signature.files)) {
    throw new SignatureError('包文件与 signature.json 不一致');
  }
  const payload = Buffer.from(
    JSON.stringify({ algorithm: 'ed25519', files: signature.files }),
    'utf8',
  );
  try {
    const key = createPublicKey(publicKey);
    const valid = verify(null, payload, key, Buffer.from(signature.signature, 'base64'));
    if (!valid) throw new SignatureError('包签名无效');
  } catch (err) {
    if (err instanceof SignatureError) throw err;
    throw new SignatureError('无法校验包签名');
  }
}

/** SHA-256 hashes for every non-signature file, sorted by path for stability. */
export function packageFileHashes(files: Map<string, Uint8Array>): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const name of [...files.keys()].sort()) {
    if (name === SIGNATURE_FILE) continue;
    const data = files.get(name);
    if (!data) continue;
    hashes[name] = createHash('sha256').update(data).digest('hex');
  }
  return hashes;
}
