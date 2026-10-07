import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

// Integration suite hits the real dev database. Skipped when it is unreachable
// (e.g. CI without a MySQL service) so the pure-logic suites stay hermetic.
const dbAvailable = await (async () => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dbAvailable)('auth integration (real DB)', () => {
  let app: FastifyInstance;
  const email = `it_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let token = '';

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const session = await createTestUser(app, email, password);
    token = session.token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
  });

  it('logs in with valid credentials and sets an HttpOnly cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; user: { email: string } };
    expect(typeof body.token).toBe('string');
    expect(body.user.email).toBe(email);
    const session = res.cookies.find((c) => c.name === 'sp_session');
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite?.toLowerCase()).toBe('lax');
    // The `Secure` flag is forced on in production by `resolveCookieSecure`
    // (SECURITY-AUDIT-2026-10-04 M-1); it is asserted at the unit level in
    // `tests/unit/cookie-security.test.ts` because the suite runs as `test`.
  });

  it('rejects a wrong password with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email, password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for /auth/me without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the current user for /auth/me with a token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: { email: string } }).user.email).toBe(email);
  });

  it('forbids a USER from admin endpoints with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('restricts the audit log to admins and serves it paginated', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: '/admin/audit-log',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const prisma = getPrisma();
    const adminEmail = `it_admin_${Date.now()}@example.com`;
    const admin = await createAdminUser(app, adminEmail, password);
    const adminToken = admin.token;
    const ok = await app.inject({
      method: 'GET',
      url: '/admin/audit-log?page=1&pageSize=5',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { logs: unknown[]; total: number };
    expect(Array.isArray(body.logs)).toBe(true);
    expect(body.total).toBeGreaterThan(0);

    const filtered = await app.inject({
      method: 'GET',
      url: '/admin/audit-log?page=1&pageSize=5&action=auth.forbidden&resource=permission',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(filtered.statusCode).toBe(200);
    const filteredBody = filtered.json() as {
      logs: Array<{ action: string; resource: string }>;
      total: number;
    };
    expect(filteredBody.total).toBeGreaterThan(0);
    for (const log of filteredBody.logs) {
      expect(log.action).toBe('auth.forbidden');
      expect(log.resource).toBe('permission');
    }

    const invalid = await app.inject({
      method: 'GET',
      url: '/admin/audit-log?page=abc',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(invalid.statusCode).toBe(422);
    const invalidBody = invalid.json() as { detail?: string; code: string };
    expect(invalidBody.detail).toBe('请求参数无效');
    expect(invalidBody.code).toBe('validation.invalid');
    await prisma.user.deleteMany({ where: { email: adminEmail } });
  });

  it('records denied-auth audit entries', async () => {
    const prisma = getPrisma();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const logs = await prisma.auditLog.findMany({
      where: { actorId: user.id, action: 'auth.forbidden' },
    });
    expect(logs.length).toBeGreaterThan(0);
  });
});
