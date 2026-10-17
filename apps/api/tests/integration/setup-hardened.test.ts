import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Setup wizard, hardened mode: a claim token is configured. The wizard must
 * require it, and self-service signup must not be able to elect the first admin
 * (which would bypass the token). Env is read at import time, so the token is
 * set here before the app module is imported.
 */
const TOKEN = 'test_setup_token_0123456789abcdef0123456789abcdef';
process.env.STACKPANEL_SETUP_TOKEN = TOKEN;

const { buildApp } = await import('../../src/app.ts');
const { getPrisma } = await import('../../src/plugins/prisma.ts');
const { checkDbAvailable } = await import('../helpers.ts');

const dbAvailable = await checkDbAvailable();

/** Reset the instance to "unclaimed" for a deterministic hardened-mode run. */
async function resetInstallation(): Promise<void> {
  const prisma = getPrisma();
  await prisma.userGroup.deleteMany({});
  await prisma.userIdentity.deleteMany({});
  await prisma.user.deleteMany({});
}

describe.skipIf(!dbAvailable)('setup wizard — hardened (real DB)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    await resetInstallation();
  });

  afterAll(async () => {
    await app.close();
  });

  it('advertises that a token is required', async () => {
    const res = await app.inject({ method: 'GET', url: '/setup/status' });
    expect(res.json()).toEqual({ required: true, tokenRequired: true });
  });

  it('refuses registration that would elect the first admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email: `hardened_${Date.now()}@example.com`, password: 'SetupPass123' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('auth.setup_required');
  });

  it('rejects a missing or wrong claim token', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: { email: `hardened_a_${Date.now()}@example.com`, password: 'SetupPass123' },
    });
    expect(missing.statusCode).toBe(401);

    const wrong = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: {
        email: `hardened_b_${Date.now()}@example.com`,
        password: 'SetupPass123',
        setupToken: 'not-the-token-0000000000000000',
      },
    });
    expect(wrong.statusCode).toBe(401);
    expect((wrong.json() as { code: string }).code).toBe('setup.token_invalid');

    // Neither attempt created an admin.
    expect(await getPrisma().userGroup.count({ where: { groupId: 'group_admin' } })).toBe(0);
  });

  it('claims the instance with the correct token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: {
        email: `hardened_ok_${Date.now()}@example.com`,
        password: 'SetupPass123',
        setupToken: TOKEN,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(await getPrisma().userGroup.count({ where: { groupId: 'group_admin' } })).toBe(1);
  });
});
