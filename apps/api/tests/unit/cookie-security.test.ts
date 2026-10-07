import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * SECURITY-AUDIT-2026-10-04 M-1: the session cookie's `Secure` flag has two
 * independent guards — the env default and a `NODE_ENV==='production'` override
 * applied at set time — so a mis-set variable can never ship cookies over HTTP.
 */
describe('resolveCookieSecure', () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env['NODE_ENV'];
  });

  it('is on whenever production, regardless of the configured value', async () => {
    vi.resetModules();
    process.env['NODE_ENV'] = 'production';
    const { resolveCookieSecure } = await import('../../src/lib/cookie-security.ts');
    expect(resolveCookieSecure(false, 'production')).toBe(true);
    expect(resolveCookieSecure(true, 'production')).toBe(true);
  });

  it('honours an explicit true outside production', async () => {
    const { resolveCookieSecure } = await import('../../src/lib/cookie-security.ts');
    expect(resolveCookieSecure(true, 'development')).toBe(true);
    expect(resolveCookieSecure(true, 'test')).toBe(true);
  });

  it('stays off outside production when not configured', async () => {
    const { resolveCookieSecure } = await import('../../src/lib/cookie-security.ts');
    expect(resolveCookieSecure(false, 'development')).toBe(false);
    expect(resolveCookieSecure(false, undefined)).toBe(false);
  });
});
