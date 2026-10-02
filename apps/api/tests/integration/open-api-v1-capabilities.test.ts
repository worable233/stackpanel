import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * Open platform /api/v1 slice three: plugin-contributed capabilities, per-token
 * quota, and per-token usage audit (PLAN-open-platform P1).
 *
 * Slice four adds kernel `user` capabilities and refines the scope vocabulary to
 * `资源:read|write`; the refined-scope cases below pin that a read token can
 * never perform a write.
 */
describe.skipIf(!dbAvailable)('open API v1 plugin capabilities (real DB)', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  const adminEmail = `plat3_admin_${suffix}@example.com`;
  const userEmail = `plat3_user_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let adminId = '';
  let userToken = '';
  let productId = '';
  const tokenIds: string[] = [];
  const createdUserEmails: string[] = [];

  /** Create a token for the current user and return its id + plaintext. */
  async function createToken(sessionToken: string, scopes: string[]): Promise<{ id: string; token: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/me/api-tokens',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { name: `test-${suffix}`, scopes, ipAllowlist: [] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; apiToken: { id: string } };
    tokenIds.push(body.apiToken.id);
    return { id: body.apiToken.id, token: body.token };
  }

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    adminToken = admin.token;
    adminId = admin.userId;
    userToken = user.token;

    // Enable store so it contributes open capabilities.
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    const enable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);

    const created = await app.inject({
      method: 'POST',
      url: '/store/admin/products',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: `plat3-product-${suffix}`, price: 1000, currency: 'CNY', stock: 3 },
    });
    expect(created.statusCode).toBe(201);
    productId = (created.json() as { product: { id: string } }).product.id;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    if (tokenIds.length > 0) {
      await prisma.apiTokenUsage.deleteMany({ where: { apiTokenId: { in: tokenIds } } });
      await prisma.apiToken.deleteMany({ where: { id: { in: tokenIds } } });
    }
    if (productId) {
      await prisma.$executeRawUnsafe(`DELETE FROM "ext_store_product" WHERE "id" = $1`, productId);
    }
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    await prisma.user.deleteMany({
      where: { email: { in: [adminEmail, userEmail, ...createdUserEmails] } },
    });
    await app.close();
  });

  it('lists plugin-contributed capabilities to an authorized caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/capabilities',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { capabilities: Array<{ id: string }> }).capabilities.map(
      (capability) => capability.id,
    );
    expect(ids).toContain('store.products.list');
    expect(ids).toContain('store.orders.list');
  });

  it('serves a public plugin capability under /api/v1 unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/store/products' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { products: Array<{ id: string }> };
    expect(body.products.some((product) => product.id === productId)).toBe(true);
  });

  it('enforces the mirrored permission on a scoped plugin capability via token scope', async () => {
    // A token without `store.view` cannot read orders...
    const noScope = await createToken(userToken, []);
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/store/orders',
      headers: { authorization: `Bearer ${noScope.token}` },
    });
    expect(denied.statusCode).toBe(403);

    // ...a token that carries `store.view` can.
    const withScope = await createToken(userToken, ['store.view']);
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/v1/store/orders',
      headers: { authorization: `Bearer ${withScope.token}` },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('records one usage row per token call, tagged with the capability id', async () => {
    const scoped = await createToken(userToken, ['store.view']);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/store/orders',
      headers: { authorization: `Bearer ${scoped.token}` },
    });
    expect(res.statusCode).toBe(200);

    // Audit writes are fire-and-forget; poll briefly.
    const prisma = getPrisma();
    let rows: Array<{ capabilityId: string | null; path: string }> = [];
    for (let attempt = 0; attempt < 20 && rows.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      rows = await prisma.apiTokenUsage.findMany({ where: { apiTokenId: scoped.id } });
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.capabilityId).toBe('store.orders.list');
    expect(rows[0]?.path).toBe('/api/v1/store/orders');

    const usage = await app.inject({
      method: 'GET',
      url: `/me/api-tokens/${scoped.id}/usage`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(usage.statusCode).toBe(200);
    expect((usage.json() as { usage: unknown[] }).usage.length).toBeGreaterThan(0);
  });

  it('rejects a token that tries to grant a scope its owner lacks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/api-tokens',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { name: 'over-scoped', scopes: ['platform.admin'], ipAllowlist: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  // --- Slice four: refined `资源:read|write` capabilities (user + gateway) ---

  it('advertises the kernel user capabilities', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/capabilities',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const byId = new Map(
      (
        res.json() as { capabilities: Array<{ id: string; scope: string | null }> }
      ).capabilities.map((capability) => [capability.id, capability.scope]),
    );
    expect(byId.get('user.list')).toBe('user:read');
    expect(byId.get('user.create')).toBe('user:write');
  });

  it('lists and reads users through the shared kernel service with user:read', async () => {
    const readToken = await createToken(adminToken, ['user:read']);
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/users?q=plat3_admin_${suffix}`,
      headers: { authorization: `Bearer ${readToken.token}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { users: Array<{ email: string }> };
    expect(body.users.some((user) => user.email === adminEmail)).toBe(true);

    const target = body.users.find((user) => user.email === adminEmail);
    expect(target).toBeDefined();

    // A read token is refused on every write operation (refinement is real).
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${readToken.token}`, 'idempotency-key': randomUUID() },
      payload: { email: `plat4_forbidden_${suffix}@example.com` },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('creates, updates and resets a user with user:write (idempotent)', async () => {
    const writeToken = await createToken(adminToken, ['user:write']);
    const createdEmail = `plat4_created_${suffix}@example.com`;
    createdUserEmails.push(createdEmail);

    const createKey = randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${writeToken.token}`, 'idempotency-key': createKey },
      payload: { email: createdEmail, password },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json() as { user: { id: string; email: string } };
    expect(createdBody.user.email).toBe(createdEmail);
    const createdId = createdBody.user.id;

    // Replaying the same key is memoised, not re-executed.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${writeToken.token}`, 'idempotency-key': createKey },
      payload: { email: createdEmail, password },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotency-replayed']).toBe('true');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${createdId}`,
      headers: { authorization: `Bearer ${writeToken.token}`, 'idempotency-key': randomUUID() },
      payload: { status: 'DISABLED' },
    });
    expect(patched.statusCode).toBe(200);

    const reset = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${createdId}/reset-password`,
      headers: { authorization: `Bearer ${writeToken.token}`, 'idempotency-key': randomUUID() },
      payload: {},
    });
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as { generatedPassword?: string }).generatedPassword).toBeTruthy();
  });

  it('a delegated user-manager cannot escalate to administrator via user:write (audit H-1)', async () => {
    const prisma = getPrisma();
    const managerEmail = `plat4_usermgr_${suffix}@example.com`;
    createdUserEmails.push(managerEmail);

    // A group that delegates user management but not platform administration.
    const group = await prisma.permissionGroup.create({ data: { name: `it-usermgr-${suffix}` } });
    const manageUsers = await prisma.permission.findUniqueOrThrow({
      where: { key: 'platform.manage.users' },
    });
    await prisma.groupPermission.create({
      data: { groupId: group.id, permissionId: manageUsers.id },
    });
    const manager = await createTestUser(app, managerEmail, password, {
      groupIds: [group.id],
    });
    const token = await createToken(manager.token, ['user:write']);

    // Granting an administrator group is refused.
    const escalate = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${token.token}`, 'idempotency-key': randomUUID() },
      payload: { email: `plat4_escalated_${suffix}@example.com`, groupIds: ['group_admin'] },
    });
    expect(escalate.statusCode).toBe(403);
    expect((escalate.json() as { code: string }).code).toBe('user.admin_required');

    // Operating on an existing administrator is refused.
    const touchAdmin = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${adminId}`,
      headers: { authorization: `Bearer ${token.token}`, 'idempotency-key': randomUUID() },
      payload: { groupIds: ['group_user'] },
    });
    expect(touchAdmin.statusCode).toBe(403);
    expect((touchAdmin.json() as { code: string }).code).toBe('user.admin_required');

    // Managing an ordinary user still works — delegation is intact.
    const ordinaryEmail = `plat4_ordinary_${suffix}@example.com`;
    createdUserEmails.push(ordinaryEmail);
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${token.token}`, 'idempotency-key': randomUUID() },
      payload: { email: ordinaryEmail, password },
    });
    expect(allowed.statusCode).toBe(201);

    await prisma.permissionGroup.delete({ where: { id: group.id } });
  });

  it('rejects a write without an Idempotency-Key', async () => {
    const writeToken = await createToken(adminToken, ['user:write']);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${randomUUID()}/wallet`,
      headers: { authorization: `Bearer ${writeToken.token}` },
      payload: { amount: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('request.idempotency_key_required');
  });
});
