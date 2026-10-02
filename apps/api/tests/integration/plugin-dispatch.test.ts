import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

function pluginZip(id: string, version: string, extra: Record<string, string> = {}): Buffer {
  const entry = `
    import { definePlugin } from '@stackpanel/sdk';
    const p = definePlugin({
      manifest: { id: '${id}', name: '${id}', version: '${version}' },
      routes: [
        { method: 'GET', path: '/${id}', handler: async () => ({ id: '${id}', version: '${version}' }) },
        { method: 'POST', path: '/${id}/items/:itemId', handler: async (req) => ({ itemId: req.params['itemId'] }) },
      ],
    });
    export default p;
  `;
  const files: Record<string, string> = {
    'manifest.json': JSON.stringify({
      id,
      name: id,
      version,
      apiVersion: '>=0.4.0',
    }),
    'dist/index.js': entry,
    ...extra,
  };
  const u8: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(files)) u8[key] = strToU8(value);
  return Buffer.from(zipSync(u8));
}

function zipToMultipart(
  fileBuffer: Buffer,
  filename: string,
): { payload: Buffer; boundary: string } {
  const boundary = '----stackpanel-plugin-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, fileBuffer, tail]), boundary };
}

describe.skipIf(!dbAvailable)('plugin hot-load dispatcher (real DB)', () => {
  let app: FastifyInstance;
  let dataDir = '';
  const adminEmail = `dispatch_admin_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';

  const upload = async (buf: Buffer, name: string) => {
    const { payload, boundary } = zipToMultipart(buf, name);
    return app.inject({
      method: 'POST',
      url: '/admin/plugins/upload',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
  };

  beforeAll(async () => {
    // Temp data dir INSIDE the repo so dynamically-imported plugin dist files
    // resolve bare specifiers (@stackpanel/sdk, zod) via apps/api/node_modules.
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-testdata-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const admin = await createAdminUser(app, adminEmail, password);
    adminToken = admin.token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.plugin.deleteMany({
      where: { id: { in: ['alpha', 'bad', 'bad2', 'bad3', 'bad4'] } },
    });
    await prisma.user.deleteMany({ where: { email: adminEmail } });
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('seeds and registers the built-in plugins from the data dir', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/plugins',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      plugins: Array<{ id: string; source: string; hotReload: boolean }>;
    };
    for (const id of ['store', 'store-product-card', 'store-product-server', 'store-wallet']) {
      const plugin = body.plugins.find((p) => p.id === id);
      expect(plugin).toBeTruthy();
      expect(plugin?.source).toBe('builtin');
      expect(plugin?.hotReload).toBe(true);
    }
  });

  it('serves a built-in route once enabled via the dispatcher', async () => {
    const enable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/products' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { products: unknown[] };
    expect(Array.isArray(body.products)).toBe(true);
  });

  it('hot-installs a plugin and its routes are live without a restart', async () => {
    const res = await upload(pluginZip('alpha', '1.0.0'), 'alpha.zip');
    expect(res.statusCode).toBe(201);
    const body = res.json() as { installed: boolean; live: boolean; upgraded: boolean };
    expect(body.installed).toBe(true);
    expect(body.live).toBe(true);

    const route = await app.inject({ method: 'GET', url: '/alpha' });
    expect(route.statusCode).toBe(200);
    expect((route.json() as { version: string }).version).toBe('1.0.0');

    const paramRoute = await app.inject({ method: 'POST', url: '/alpha/items/abc123' });
    expect(paramRoute.statusCode).toBe(200);
    expect((paramRoute.json() as { itemId: string }).itemId).toBe('abc123');
  });

  it('hot-upgrades an installed plugin (new version live immediately)', async () => {
    const res = await upload(pluginZip('alpha', '2.0.0'), 'alpha.zip');
    expect(res.statusCode).toBe(201);
    expect((res.json() as { upgraded: boolean }).upgraded).toBe(true);

    const route = await app.inject({ method: 'GET', url: '/alpha' });
    expect(route.statusCode).toBe(200);
    expect((route.json() as { version: string }).version).toBe('2.0.0');
  });

  it('keeps the current plugin live when an upgrade module cannot load', async () => {
    const broken = Buffer.from(
      zipSync({
        'manifest.json': strToU8(
          JSON.stringify({ id: 'alpha', name: 'alpha', version: '3.0.0', apiVersion: '>=0.4.0' }),
        ),
        'dist/index.js': strToU8("throw new Error('broken upgrade')"),
      }),
    );
    const res = await upload(broken, 'alpha.zip');
    expect(res.statusCode).toBe(409);
    const route = await app.inject({ method: 'GET', url: '/alpha' });
    expect(route.statusCode).toBe(200);
    expect((route.json() as { version: string }).version).toBe('2.0.0');
  });

  it('returns 404 for a deactivated hot plugin route', async () => {
    const disable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/alpha',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/alpha' });
    expect(res.statusCode).toBe(404);
  });

  it('hot-uninstalls a plugin and drops its routes', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: '/admin/plugins/alpha',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(204);
    const res = await app.inject({ method: 'GET', url: '/alpha' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a ZIP missing manifest.json', async () => {
    const res = await upload(
      Buffer.from(zipSync({ 'dist/index.js': strToU8('export default {}') })),
      'bad.zip',
    );
    expect(res.statusCode).toBe(422);
  });

  it('rejects a ZIP containing source files', async () => {
    const res = await upload(pluginZip('bad', '1.0.0', { 'src/main.ts': 'x' }), 'bad2.zip');
    expect(res.statusCode).toBe(422);
  });

  it('rejects a path-traversal entry', async () => {
    const res = await upload(pluginZip('bad2', '1.0.0', { '../evil.txt': 'x' }), 'bad3.zip');
    expect(res.statusCode).toBe(422);
  });

  it('rejects a reserved plugin id', async () => {
    const res = await upload(pluginZip('store', '9.9.9'), 'bad4.zip');
    expect(res.statusCode).toBe(409);
  });

  it('rejects an incompatible apiVersion', async () => {
    const bad = zipSync({
      'manifest.json': strToU8(
        JSON.stringify({ id: 'bad4', name: 'bad4', version: '1.0.0', apiVersion: '>=9.0.0' }),
      ),
      'dist/index.js': strToU8('export default {}'),
    });
    const res = await upload(Buffer.from(bad), 'bad5.zip');
    expect(res.statusCode).toBe(409);
  });
});
