import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Setup wizard turned off (`STACKPANEL_SETUP_MODE=disabled`). The routes must
 * disappear as a write surface even on an unclaimed instance: status reports
 * `required: false` and the claim endpoint refuses instead of minting an admin.
 * Env is read at import time, so it is set before the app module is loaded.
 */
process.env.STACKPANEL_SETUP_MODE = 'disabled';

const { buildApp } = await import('../../src/app.ts');
const { getPrisma } = await import('../../src/plugins/prisma.ts');
const { checkDbAvailable } = await import('../helpers.ts');

const dbAvailable = await checkDbAvailable();

describe.skipIf(!dbAvailable)('setup wizard — disabled (real DB)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await getPrisma().userGroup.deleteMany({});
    await getPrisma().userIdentity.deleteMany({});
    await getPrisma().user.deleteMany({});
  });

  afterAll(async () => {
    await app.close();
  });

  it('never advertises the wizard', async () => {
    const res = await app.inject({ method: 'GET', url: '/setup/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ required: false, tokenRequired: false });
  });

  it('refuses to claim an unclaimed instance', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: { email: `disabled_${Date.now()}@example.com`, password: 'SetupPass123' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('setup.disabled');

    expect(await getPrisma().userGroup.count({ where: { groupId: 'group_admin' } })).toBe(0);
  });
});
