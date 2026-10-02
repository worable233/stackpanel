import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { createAdminUser } from '../auth-helpers.ts';

const dbAvailable = await (async () => {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dbAvailable)('admin application market (real DB)', () => {
  let app: FastifyInstance;
  const email = `it_market_${Date.now()}@example.com`;
  const password = 'test_password_123456';
  let adminToken: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const admin = await createAdminUser(app, email, password);
    adminToken = admin.token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
  });

  it('lists market plugins with installed state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/market/plugins',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { plugins } = res.json() as {
      plugins: Array<{
        id: string;
        name: string;
        version: string;
        kind: 'plugin';
        installed: boolean;
        builtin: boolean;
      }>;
    };
    expect(plugins.length).toBeGreaterThan(0);
    const store = plugins.find((p) => p.id === 'store');
    expect(store).toBeDefined();
    expect(store?.kind).toBe('plugin');
    // The built-in store plugin is seeded at boot, so it reports installed.
    expect(store?.installed).toBe(true);
  });

  it('lists market themes with installed state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/market/themes',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { themes } = res.json() as {
      themes: Array<{ id: string; kind: 'theme'; installed: boolean; builtin: boolean }>;
    };
    expect(themes.length).toBeGreaterThan(0);
    const defaultTheme = themes.find((t) => t.id === 'default');
    expect(defaultTheme).toBeDefined();
    expect(defaultTheme?.builtin).toBe(true);
    expect(defaultTheme?.installed).toBe(true);
  });

  it('rejects market install for an unknown id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/market/plugins/does-not-exist/install',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it('installs a plugin from the market (store-product-card, already built)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/market/plugins/store-product-card/install',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; version: string; installed: boolean };
    expect(body.id).toBe('store-product-card');
    expect(body.installed).toBe(true);
    expect(typeof body.version).toBe('string');
  });
});
