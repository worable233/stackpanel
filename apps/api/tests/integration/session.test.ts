import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { peekRedis } from '@stackpanel/db';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { signSession } from '../../src/lib/jwt.ts';
import { createTestUser } from '../auth-helpers.ts';

const dbAvailable = await (async () => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dbAvailable)('server-side sessions (real DB)', () => {
  let app: FastifyInstance;
  const email = `it_session_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let token = '';
  let userId = '';

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const session = await createTestUser(app, email, password);
    token = session.token;
    userId = session.userId;
  });

  afterAll(async () => {
    await getPrisma().user.deleteMany({ where: { email } });
    await app.close();
  });

  it('shares a session across replicas (node A logs in, node B recognises it)', async () => {
    // Only meaningful with Redis configured; skipped otherwise.
    if (!process.env.REDIS_URL || !peekRedis()) return;
    const nodeB = buildApp({ redis: peekRedis() });
    await nodeB.ready();
    await nodeB.pluginRuntime.activate('login');
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/login',
        payload: { email, password },
      });
      const token = (login.json() as { token: string }).token;
      const onB = await nodeB.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(onB.statusCode).toBe(200);
      expect((onB.json() as { user: { email: string } }).user.email).toBe(email);
    } finally {
      await nodeB.close();
    }
  });

  it('issues an opaque session token (not a JWT)', () => {
    expect(token.startsWith('sess_')).toBe(true);
    expect(token.split('.').length).not.toBe(3);
  });

  it('reports the session through /auth/session without a 401', async () => {
    const anon = await app.inject({ method: 'GET', url: '/auth/session' });
    expect(anon.statusCode).toBe(200);
    expect((anon.json() as { user: unknown }).user).toBeNull();

    const res = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { id: userId, role: 'USER' } });
  });

  it('accepts the session token via cookie as well as Bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: { sp_session: token },
    });
    expect((res.json() as { user: { id: string } }).user.id).toBe(userId);
  });

  it('revokes the session on logout and rejects replay', async () => {
    const login = await app.inject({ method: 'POST', url: '/login', payload: { email, password } });
    const fresh = (login.json() as { token: string }).token;
    expect(fresh).not.toBe(token);

    const out = await app.inject({
      method: 'POST',
      url: '/logout',
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(out.statusCode).toBe(204);

    const replay = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${fresh}` },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('revokeAllSessions invalidates every session of the user', async () => {
    const login = await app.inject({ method: 'POST', url: '/login', payload: { email, password } });
    const victim = (login.json() as { token: string }).token;

    await app.auth.revokeAllSessions(userId);

    const after = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${victim}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('migrates a legacy JWT into a server-side session', async () => {
    const legacy = await signSession({ sub: userId, jti: `${Date.now()}` });
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${legacy}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: { email: string } }).user.email).toBe(email);

    // The same legacy token is adopted once and keeps working (and is revocable).
    const again = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${legacy}` },
    });
    expect(again.statusCode).toBe(200);
  });
});
