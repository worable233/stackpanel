import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
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

function lifecyclePluginZip(): Buffer {
  const entry = `
    const plugin = {
      manifest: { id: 'lifecycle', name: 'Lifecycle Test', version: '1.0.0' },
      onActivate: () => {
        globalThis.__lifecycleActivations = (globalThis.__lifecycleActivations ?? 0) + 1;
      },
      routes: [
        {
          method: 'GET',
          path: '/lifecycle',
          handler: async () => ({
            message: 'lifecycle plugin',
            activations: globalThis.__lifecycleActivations ?? 0,
          }),
        },
      ],
    };
    export default plugin;
  `;
  return Buffer.from(
    zipSync({
      'manifest.json': strToU8(
        JSON.stringify({ id: 'lifecycle', name: 'Lifecycle Test', version: '1.0.0', apiVersion: '>=0.4.0' }),
      ),
      'dist/index.js': strToU8(entry),
    }),
  );
}

function multipart(fileBuffer: Buffer, filename: string): { payload: Buffer; boundary: string } {
  const boundary = '----stackpanel-lifecycle-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, fileBuffer, tail]), boundary };
}

describe.skipIf(!dbAvailable)('plugin runtime integration (real DB)', () => {
  let app: FastifyInstance;
  let dataDir = '';
  const email = `it_plug_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';

  beforeAll(async () => {
    // Temp data dir INSIDE the repo so dynamically-imported plugin dist files
    // resolve bare specifiers via apps/api/node_modules.
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-testdata-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    adminToken = (await createAdminUser(app, email, password)).token;
    await getPrisma().plugin.deleteMany({ where: { id: 'lifecycle' } });
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.user.deleteMany({ where: { email } });
    await prisma.plugin.deleteMany({ where: { id: 'lifecycle' } });
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('uploads the plugin and lists it as enabled', async () => {
    const { payload, boundary } = multipart(lifecyclePluginZip(), 'lifecycle.zip');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/plugins/upload',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { live: boolean }).live).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: '/admin/plugins',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    const plugin = (
      list.json() as {
        plugins: Array<{
          id: string;
          enabled: boolean;
          description: string | null;
          dependencies: unknown[];
          consumesStatus: unknown[];
        }>;
      }
    ).plugins.find((p) => p.id === 'lifecycle');
    expect(plugin).toBeTruthy();
    expect(plugin?.enabled).toBe(true);
    expect(Array.isArray(plugin?.dependencies)).toBe(true);
    expect(Array.isArray(plugin?.consumesStatus)).toBe(true);
  });

  it('serves the plugin route while it is enabled', async () => {
    const live = await app.inject({ method: 'GET', url: '/lifecycle' });
    expect(live.statusCode).toBe(200);
    const body = live.json() as { message: string; activations: number };
    expect(body.message).toContain('lifecycle');
    expect(body.activations).toBeGreaterThan(0);
  });

  it('disables the plugin and the route goes back to 404', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/lifecycle',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);

    const live = await app.inject({ method: 'GET', url: '/lifecycle' });
    expect(live.statusCode).toBe(404);
  });

  it('rejects unknown plugin ids', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/nope',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('records plugin activate/deactivate audit entries', async () => {
    // A fresh upload installs and activates; re-enable after the previous test
    // disabled it so both activate and deactivate appear in the audit trail.
    await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/lifecycle',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    const prisma = getPrisma();
    const logs = await prisma.auditLog.findMany({
      where: { resource: 'plugin', resourceId: 'lifecycle' },
      orderBy: { createdAt: 'desc' },
    });
    const actions = logs.map((l) => l.action);
    expect(actions).toContain('plugin.install');
    expect(actions).toContain('plugin.activate');
    expect(actions).toContain('plugin.deactivate');
  });
});
