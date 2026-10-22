import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { signSession } from '../../src/lib/jwt.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * Regression: the opaque-session migration no longer accepts a legacy
 * stateless JWT, so revocation cannot be bypassed by re-adoption.
 */
describe.skipIf(!dbAvailable)('regression: legacy JWT cannot bypass revocation', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  const email = `audit_legacy_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let userId = '';
  let legacy = '';

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const user = await createTestUser(app, email, password);
    userId = user.userId;
    legacy = await signSession({ sub: userId, jti: `audit-${suffix}` });
  });

  afterAll(async () => {
    await getPrisma().user.deleteMany({ where: { email } });
    await app.close();
  });

  it('rejects a legacy JWT before and after every session was revoked', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${legacy}` },
    });
    expect(first.statusCode).toBe(401);

    await app.auth.revokeAllSessions(userId);

    // A modern opaque session is gone for good after revokeAll.
    const login = await app.inject({ method: 'POST', url: '/login', payload: { email, password } });
    const opaque = (login.json() as { token: string }).token;
    await app.auth.revokeAllSessions(userId);
    const opaqueAfter = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${opaque}` },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${legacy}` },
    });

    expect(opaqueAfter.statusCode).toBe(401);
    expect(after.statusCode).toBe(401);
  });
});
