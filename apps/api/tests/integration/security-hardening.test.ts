import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * SECURITY-AUDIT-2026-10-04 hardening, end to end:
 *  - M-2: security headers (notably HSTS) are present on every response.
 *  - M-3: the Swagger UI at `/docs` is not reachable without `platform.admin`.
 *  - L-2: the machine surface no longer advertises `script-src 'unsafe-inline'`.
 */
describe.skipIf(!dbAvailable)('security hardening (real DB)', () => {
  let app: FastifyInstance;
  let adminToken = '';
  let userToken = '';
  const suffix = Date.now();

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    adminToken = (await createAdminUser(app, `sec_admin_${suffix}@example.com`)).token;
    userToken = (await createTestUser(app, `sec_user_${suffix}@example.com`)).token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('sends HSTS and hardening headers on ordinary responses (M-2)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('does not advertise unsafe-inline scripts on the machine surface (L-2)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).not.toContain(
      "script-src 'self' 'unsafe-inline'",
    );
  });

  it('hides /docs from anonymous and non-admin callers (M-3)', async () => {
    const anon = await app.inject({ method: 'GET', url: '/docs' });
    expect(anon.statusCode).toBe(404);
    const reader = await app.inject({
      method: 'GET',
      url: '/docs',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(reader.statusCode).toBe(404);
  });

  it('serves /docs to an admin (M-3)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/docs',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });
});
