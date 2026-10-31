import { afterEach, describe, expect, it } from 'vitest';
import { credentialBucketKey } from '../../src/routes/auth.ts';
import { resetRuntimeConfigForTest } from '../../src/config/runtime-config.ts';

/**
 * Bucket key for the re-authentication routes (`/auth/password`, `/auth/email`).
 *
 * The default `@fastify/rate-limit` key is the source IP, which is wrong here:
 * the web BFF calls the API server-to-server, so every end user arrives from the
 * same IP and an IP-keyed bucket becomes a site-wide ceiling — ten password
 * changes a minute would start rejecting everybody else. These tests pin the
 * "one bucket per session" property that makes the limiter safe to ship.
 */
afterEach(() => {
  resetRuntimeConfigForTest();
});

describe('credential bucket key', () => {
  it('keys on the presented credential, so users behind one IP do not share a bucket', () => {
    const alice = credentialBucketKey({
      ip: '10.0.0.5',
      headers: { authorization: 'Bearer sess_alice' },
    });
    const bob = credentialBucketKey({
      ip: '10.0.0.5',
      headers: { authorization: 'Bearer sess_bob' },
    });
    expect(alice).not.toBe(bob);
    // Stable for the same caller, otherwise the limit never accumulates.
    expect(
      credentialBucketKey({ ip: '10.0.0.5', headers: { authorization: 'Bearer sess_alice' } }),
    ).toBe(alice);
  });

  it('falls back to the session cookie when no bearer is presented', () => {
    const viaCookie = credentialBucketKey({
      ip: '10.0.0.5',
      cookies: { sp_session: 'sess_alice' },
    });
    const viaBearer = credentialBucketKey({
      ip: '10.0.0.5',
      headers: { authorization: 'Bearer sess_alice' },
    });
    expect(viaCookie).toBe(viaBearer);
  });

  it('falls back to the source IP only when the caller presents no credential', () => {
    expect(credentialBucketKey({ ip: '127.0.0.1' })).toBe('ip:127.0.0.1');
    expect(credentialBucketKey({})).toBe('ip:unknown');
  });

  it('never leaks the raw session token into the rate-limit key namespace', () => {
    const key = credentialBucketKey({ headers: { authorization: 'Bearer sess_super_secret' } });
    expect(key).not.toContain('sess_super_secret');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });
});
