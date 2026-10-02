import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * CONTRACT-SEC integration: the H2 credential limiter actually engages, the H3
 * secret surface reports a machine-readable state, and G1/G2 wiring is inert on
 * ordinary traffic (no stray deprecation headers).
 *
 * The setup file raises `API_RATE_LIMIT_MULTIPLIER` so the rest of the suite is
 * never throttled; this file alone resets it to 1 before building the app so the
 * real preset ceilings apply.
 */
describe.skipIf(!dbAvailable)('CONTRACT-SEC (real DB)', () => {
  let app: FastifyInstance;
  let userToken = '';
  const savedMultiplier = process.env['API_RATE_LIMIT_MULTIPLIER'];
  const suffix = Date.now();

  beforeAll(async () => {
    process.env['API_RATE_LIMIT_MULTIPLIER'] = '1';
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const user = await createTestUser(app, `contractsec_${suffix}@example.com`);
    userToken = user.token;
    // Ensure a clean window for the credential limiter.
    const prisma = getPrisma();
    await prisma.apiToken.deleteMany({ where: { user: { email: `contractsec_${suffix}@example.com` } } });
  });

  afterAll(async () => {
    if (savedMultiplier === undefined) delete process.env['API_RATE_LIMIT_MULTIPLIER'];
    else process.env['API_RATE_LIMIT_MULTIPLIER'] = savedMultiplier;
    await app.close();
  });

  it('revokes an API token immediately, with no cached-auth window (audit M-1)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/me/api-tokens',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { name: `m1-${suffix}`, scopes: [], ipAllowlist: [] },
    });
    expect(created.statusCode).toBe(200);
    const { token, apiToken } = created.json() as {
      token: string;
      apiToken: { id: string };
    };

    // The token works while live.
    const live = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(live.statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/me/api-tokens/${apiToken.id}`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(revoked.statusCode).toBe(200);

    // ...and stops working on the very next request (the old positive cache let
    // it through for up to 30s).
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('throttles credential issuance once the policy ceiling is reached', async () => {
    let throttled = 0;
    let lastStatus = 0;
    let retryAfter: string | undefined;
    // credentialWrite preset = 30/min; the 31st request must be rejected.
    for (let i = 0; i < 32; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/me/api-tokens',
        headers: { authorization: `Bearer ${userToken}` },
        payload: { name: `rl-${suffix}-${i}`, scopes: [], ipAllowlist: [] },
      });
      lastStatus = res.statusCode;
      if (res.statusCode === 429) {
        throttled += 1;
        retryAfter = res.headers['retry-after'] as string | undefined;
      }
    }
    expect(throttled).toBeGreaterThan(0);
    expect(lastStatus).toBe(429);
    expect(retryAfter).toBeDefined();
  });

  it('reports the secret-storage state in a machine-readable shape (H3)', async () => {
    const admin = await createAdminUser(app, `contractsec_admin_${suffix}@example.com`);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/secrets',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { enabled: boolean; reason?: string };
    // The test environment configures SETTINGS_ENCRYPTION_KEY.
    expect(body.enabled).toBe(true);
  });

  it('leaves ordinary responses free of deprecation headers (G1 inert)', async () => {
    const res = await app.inject({ method: 'GET', url: '/platform/info' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['deprecation']).toBeUndefined();
    expect(res.headers['sunset']).toBeUndefined();
  });
});
