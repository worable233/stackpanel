import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_COOKIE_NAME,
  DEFAULT_SESSION_TTL_SECONDS,
  sessionCookieMaxAge,
  sessionCookieName,
  sessionCookieOptions,
  sessionCookieSecure,
} from '../src/lib/session-cookie';

/**
 * Session-cookie policy, web side (ADR-0017 §4, security audit M-1).
 *
 * These pin the flag that had drifted: `secure` used to be
 * `NODE_ENV === 'production'`, a build-time variable, so a TLS deployment whose
 * image ran with `NODE_ENV` unset handed out a session cookie *without*
 * `Secure` — readable and replayable by anyone on the wire.
 */

afterEach(() => {
  delete process.env.SESSION_COOKIE_NAME;
  delete process.env.SESSION_TTL_SECONDS;
  delete process.env.API_COOKIE_SECURE;
});

describe('session cookie naming', () => {
  it('defaults to the documented name', () => {
    expect(sessionCookieName()).toBe(DEFAULT_SESSION_COOKIE_NAME);
  });

  it('honours the deployment override, ignoring blank values', () => {
    process.env.SESSION_COOKIE_NAME = 'custom_session';
    expect(sessionCookieName()).toBe('custom_session');
    process.env.SESSION_COOKIE_NAME = '   ';
    expect(sessionCookieName()).toBe(DEFAULT_SESSION_COOKIE_NAME);
  });

  it('defaults the lifetime and rejects values that cannot be a maxAge', () => {
    expect(sessionCookieMaxAge()).toBe(DEFAULT_SESSION_TTL_SECONDS);
    process.env.SESSION_TTL_SECONDS = '600';
    expect(sessionCookieMaxAge()).toBe(600);
    process.env.SESSION_TTL_SECONDS = 'not-a-number';
    expect(sessionCookieMaxAge()).toBe(DEFAULT_SESSION_TTL_SECONDS);
    process.env.SESSION_TTL_SECONDS = '-5';
    expect(sessionCookieMaxAge()).toBe(DEFAULT_SESSION_TTL_SECONDS);
  });
});

describe('session cookie Secure flag', () => {
  it('is on whenever the request arrived over TLS, regardless of NODE_ENV', () => {
    expect(sessionCookieSecure({ forwardedProto: 'https', nodeEnv: 'development' })).toBe(true);
    // Proxies append; the first hop is the client-facing scheme.
    expect(sessionCookieSecure({ forwardedProto: 'https, http', nodeEnv: 'development' })).toBe(
      true,
    );
    expect(sessionCookieSecure({ forwardedProto: 'HTTPS', nodeEnv: 'development' })).toBe(true);
  });

  it('stays on in production even without a proxy hint', () => {
    expect(sessionCookieSecure({ nodeEnv: 'production' })).toBe(true);
    expect(sessionCookieSecure({ forwardedProto: 'http', nodeEnv: 'production' })).toBe(true);
  });

  it('is off only for a plainly-http, non-production deployment (local dev)', () => {
    expect(sessionCookieSecure({ forwardedProto: 'http', nodeEnv: 'development' })).toBe(false);
    expect(sessionCookieSecure({ nodeEnv: 'development' })).toBe(false);
  });

  it('honours API_COOKIE_SECURE the same way the kernel does', () => {
    expect(sessionCookieSecure({ configured: true, nodeEnv: 'development' })).toBe(true);
    process.env.API_COOKIE_SECURE = 'true';
    expect(sessionCookieSecure({ nodeEnv: 'development' })).toBe(true);
  });

  it('never emits a script-readable or cross-site cookie', () => {
    const options = sessionCookieOptions({ forwardedProto: 'https' });
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', secure: true });
    expect(options.maxAge).toBeGreaterThan(0);
  });
});
