import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { PLATFORM_INFO_SETTING_KEY } from '../../src/lib/platform-info.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * Open platform v1 surface (PLAN-open-platform P1).
 *
 * Verifies the versioned veneer, capability discovery, and the idempotency
 * contract on mutating operations.
 */
describe.skipIf(!dbAvailable)('open API v1 (real DB)', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  const adminEmail = `openapi_admin_${suffix}@example.com`;
  const userEmail = `openapi_user_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';
  let previous: unknown = undefined;
  let hadPrevious = false;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const existing = await prisma.setting.findUnique({ where: { key: PLATFORM_INFO_SETTING_KEY } });
    hadPrevious = existing !== null;
    previous = existing?.value;
    adminToken = (await createAdminUser(app, adminEmail, password)).token;
    userToken = (await createTestUser(app, userEmail, password)).token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    if (hadPrevious) {
      await prisma.setting.upsert({
        where: { key: PLATFORM_INFO_SETTING_KEY },
        create: { key: PLATFORM_INFO_SETTING_KEY, value: previous as never },
        update: { value: previous as never },
      });
    } else {
      await prisma.setting.deleteMany({ where: { key: PLATFORM_INFO_SETTING_KEY } });
    }
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('serves the platform identity publicly under /api/v1', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/platform' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { platform: { name: string } }).platform.name).toBeTruthy();
  });

  it('reports the caller identity and resolves capabilities', async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { user: { email: string }; effectivePermissions: string[] };
    expect(body.user.email).toBe(userEmail);
    expect(Array.isArray(body.effectivePermissions)).toBe(true);

    const caps = await app.inject({
      method: 'GET',
      url: '/api/v1/capabilities',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(caps.statusCode).toBe(200);
    const ids = (caps.json() as { capabilities: Array<{ id: string }> }).capabilities.map(
      (capability) => capability.id,
    );
    expect(ids).toContain('platform.info.write');
  });

  it('requires an Idempotency-Key on mutating capabilities', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/platform',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Open API', description: 'via open api', url: null },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe('request.idempotency_key_required');
  });

  it('replays the same response for a repeated Idempotency-Key', async () => {
    const key = `idem-${suffix}-0001`;
    const first = await app.inject({
      method: 'PATCH',
      url: '/api/v1/platform',
      headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
      payload: { name: 'Open API', description: 'via open api', url: null },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'PATCH',
      url: '/api/v1/platform',
      headers: { authorization: `Bearer ${adminToken}`, 'idempotency-key': key },
      payload: { name: 'Changed Name', description: 'should not apply', url: null },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
  });

  it('serves the caller wallet balance and ledger, and admin can list accounts', async () => {
    const userMe = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${userToken}` },
    });
    const userId = (userMe.json() as { user: { id: string } }).user.id;
    await app.wallet.credit(userId, 5000, 'CNY', {
      type: 'ADMIN_ADJUST',
      referenceType: 'OPENAPI_TEST',
      referenceId: `seed-${suffix}`,
      note: 'open api test',
    });

    const balance = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/balance',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(balance.statusCode).toBe(200);
    expect((balance.json() as { account: { balance: number } }).account.balance).toBe(5000);

    const ledger = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/ledger?limit=10',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(ledger.statusCode).toBe(200);
    const entries = (ledger.json() as { entries: Array<{ referenceId: string }> }).entries;
    expect(entries.some((entry) => entry.referenceId === `seed-${suffix}`)).toBe(true);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/accounts',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const accounts = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/accounts',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(accounts.statusCode).toBe(200);
    expect(Array.isArray((accounts.json() as { accounts: unknown[] }).accounts)).toBe(true);
  });

  it('rejects an out-of-range ledger limit with a 422 problem', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet/ledger?limit=9999',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect((res.json() as { code: string }).code).toBe('validation.invalid');
  });

  it('forbids non-admins from mutating the platform identity', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/platform',
      headers: { authorization: `Bearer ${userToken}`, 'idempotency-key': `idem-${suffix}-0002` },
      payload: { name: 'Nope', description: 'nope', url: null },
    });
    expect(res.statusCode).toBe(403);
  });
});
