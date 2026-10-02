import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await (async () => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dbAvailable)('RBAC hardening regression (real DB)', () => {
  let app: FastifyInstance;
  const adminEmail = `it_rbac_admin_${Date.now()}@example.com`;
  const userEmail = `it_rbac_user_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let adminId = '';

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const admin = await createAdminUser(app, adminEmail, password);
    adminToken = admin.token;
    adminId = admin.userId;
    await createTestUser(app, userEmail, password);
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('/auth/me returns the full user schema (status, timestamps)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const user = (res.json() as { user: Record<string, unknown> }).user;
    expect(typeof user.status).toBe('string');
    expect(typeof user.createdAt).toBe('string');
    expect(typeof user.updatedAt).toBe('string');
    expect('lastLoginAt' in user).toBe(true);
  });

  it('rejects deleting a structural permission group with 403', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/permission-groups/group_admin',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { detail?: string }).detail).toBe('系统内置权限组不可删除');
    // The group (and its admin memberships) must survive the rejected delete.
    const prisma = getPrisma();
    expect(
      await prisma.permissionGroup.findUnique({ where: { id: 'group_admin' } }),
    ).not.toBeNull();
  });

  it('PATCH /admin/users rejects an empty groupIds array', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${adminId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { groupIds: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('registering with a short password is rejected cleanly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email: `it_rbac_short_${Date.now()}@example.com`, password: 'short' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('validation.invalid');
  });

  it('failed logins are written to the audit log', async () => {
    await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email: userEmail, password: 'definitely-wrong' },
    });
    const prisma = getPrisma();
    const logs = await prisma.auditLog.findMany({
      where: { action: 'auth.login.failed' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    expect(logs.length).toBeGreaterThan(0);
  });

  it('the last active admin cannot be demoted or disabled', async () => {
    const prisma = getPrisma();
    // Ensure exactly one active admin remains (this suite's admin).
    await prisma.userGroup.deleteMany({ where: { groupId: 'group_admin' } });
    await prisma.userGroup.create({ data: { userId: adminId, groupId: 'group_admin' } });

    const demote = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${adminId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { groupIds: ['group_user'] },
    });
    expect(demote.statusCode).toBe(400);

    const disable = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${adminId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { status: 'DISABLED' },
    });
    expect(disable.statusCode).toBe(400);
  });

  it('a custom group can be created, updated and deleted', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/permission-groups',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: `it-group-${Date.now()}` },
    });
    expect(created.statusCode).toBe(201);
    const groupId = (created.json() as { group: { id: string } }).group.id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/permission-groups/${groupId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { permissionKeys: [] },
    });
    expect(patched.statusCode).toBe(200);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/admin/permission-groups/${groupId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleted.statusCode).toBe(200);
  });
});
