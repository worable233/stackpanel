import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bodyDigest,
  canonicalRequest,
  isValidEd25519PrivateKey,
  isValidEd25519PublicKey,
  readSignatureHeaders,
  signCanonical,
  SIGNATURE_WINDOW_SECONDS,
  verifyCanonical,
  verifyRequestSignature,
} from '../../src/reseller/signing.ts';

/** Deterministic Ed25519 key pair shared by the pure signing tests. */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const NOW_MS = 1_700_000_000_000; // fixed instant for window tests
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const BODY = JSON.stringify({ productId: 'p_1', quantity: 2 });

function signedInput(overrides: Partial<Parameters<typeof canonicalRequest>[0]> = {}) {
  const fields = {
    method: 'POST',
    path: '/sp/v1/orders',
    timestamp: String(NOW_SECONDS),
    nonce: 'nonce-0001',
    bodyDigest: bodyDigest(BODY),
    ...overrides,
  };
  return { fields, canonical: canonicalRequest(fields) };
}

describe('SP v1 signing (pure)', () => {
  it('builds the canonical string in the documented order', () => {
    const canonical = canonicalRequest({
      method: 'get',
      path: '/sp/v1/catalog?page=2',
      timestamp: '1700000000',
      nonce: 'abc',
      bodyDigest: 'deadbeef',
    });
    // method is upper-cased; fields LF-joined.
    expect(canonical).toBe('GET\n/sp/v1/catalog?page=2\n1700000000\nabc\ndeadbeef');
  });

  it('hashes the body with sha256 hex (empty body when absent)', () => {
    expect(bodyDigest(undefined)).toBe(bodyDigest(''));
    expect(bodyDigest(BODY)).toHaveLength(64);
    expect(bodyDigest('a')).not.toBe(bodyDigest('b'));
  });

  it('round-trips a signature through sign/verify', () => {
    const { canonical } = signedInput();
    const signature = signCanonical(canonical, privateKeyPem);
    expect(verifyCanonical(canonical, signature, publicKeyPem)).toBe(true);
  });

  it('rejects a signature over a tampered canonical string', () => {
    const { canonical } = signedInput();
    const signature = signCanonical(canonical, privateKeyPem);
    expect(verifyCanonical(`${canonical} `, signature, publicKeyPem)).toBe(false);
  });

  it('rejects a malformed public key without throwing', () => {
    const { canonical } = signedInput();
    const signature = signCanonical(canonical, privateKeyPem);
    expect(verifyCanonical(canonical, signature, 'not-a-key')).toBe(false);
  });

  it('validates Ed25519 key material', () => {
    expect(isValidEd25519PublicKey(publicKeyPem)).toBe(true);
    expect(isValidEd25519PrivateKey(privateKeyPem)).toBe(true);
    expect(isValidEd25519PublicKey('nope')).toBe(false);
  });

  it('accepts a valid, in-window signature', () => {
    const { fields, canonical } = signedInput();
    const verdict = verifyRequestSignature(
      { ...fields, signature: signCanonical(canonical, privateKeyPem), body: BODY, now: NOW_MS },
      publicKeyPem,
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('rejects a stale timestamp outside the window', () => {
    const stale = NOW_SECONDS - SIGNATURE_WINDOW_SECONDS - 1;
    const { fields, canonical } = signedInput({ timestamp: String(stale) });
    const verdict = verifyRequestSignature(
      { ...fields, signature: signCanonical(canonical, privateKeyPem), body: BODY, now: NOW_MS },
      publicKeyPem,
    );
    expect(verdict).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a non-numeric timestamp as malformed', () => {
    const { fields, canonical } = signedInput({ timestamp: 'soon' });
    const verdict = verifyRequestSignature(
      { ...fields, signature: signCanonical(canonical, privateKeyPem), body: BODY, now: NOW_MS },
      publicKeyPem,
    );
    expect(verdict).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a signature over a different body (body is bound)', () => {
    const { fields, canonical } = signedInput();
    const signature = signCanonical(canonical, privateKeyPem);
    const verdict = verifyRequestSignature(
      { ...fields, signature, body: '{"tampered":true}', now: NOW_MS },
      publicKeyPem,
    );
    expect(verdict).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reads the four signature headers and rejects incomplete sets', () => {
    const headers = {
      'x-sp-key-id': 'key_1',
      'x-sp-timestamp': '1700000000',
      'x-sp-nonce': 'nonce-1',
      'x-sp-signature': 'c2ln',
    };
    expect(readSignatureHeaders(headers)).toEqual({
      keyId: 'key_1',
      timestamp: '1700000000',
      nonce: 'nonce-1',
      signature: 'c2ln',
    });
    expect(readSignatureHeaders({ ...headers, 'x-sp-signature': '' })).toBeNull();
    expect(readSignatureHeaders({ 'x-sp-key-id': 'key_1' })).toBeNull();
  });

  it('rejects an over-long nonce', () => {
    const headers = {
      'x-sp-key-id': 'key_1',
      'x-sp-timestamp': '1700000000',
      'x-sp-nonce': 'n'.repeat(129),
      'x-sp-signature': 'c2ln',
    };
    expect(readSignatureHeaders(headers)).toBeNull();
  });
});
