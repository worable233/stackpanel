import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/**
 * SP v1 signing helpers for the API integration tests.
 *
 * These mirror the documented canonical string
 * (`METHOD\npath+timestamp/nonce/body-hash`) and Ed25519 rules implemented by
 * the channel plugin's `signing.ts`. They are duplicated here deliberately so
 * the API tests stay black-box (they exercise the plugin's HTTP surface, not its
 * internals); the plugin's own `signing.test.ts` pins the real implementation.
 */

export function bodyDigest(body: string | Uint8Array | undefined): string {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalRequest(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyDigest: string;
}): string {
  return [input.method.toUpperCase(), input.path, input.timestamp, input.nonce, input.bodyDigest].join(
    '\n',
  );
}

export function signCanonical(canonical: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(canonical, 'utf8'), key).toString('base64');
}

export function verifyRequestSignature(
  input: {
    method: string;
    path: string;
    timestamp: string;
    nonce: string;
    signature: string;
    body?: string | Uint8Array;
  },
  publicKeyPem: string,
): boolean {
  const canonical = canonicalRequest({
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    bodyDigest: bodyDigest(input.body),
  });
  return verify(
    null,
    Buffer.from(canonical, 'utf8'),
    createPublicKey(publicKeyPem),
    Buffer.from(input.signature, 'base64'),
  );
}

export function isValidEd25519PrivateKey(privateKey: string): boolean {
  try {
    return createPrivateKey(privateKey).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

export function isValidEd25519PublicKey(publicKey: string): boolean {
  try {
    return createPublicKey(publicKey).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}
