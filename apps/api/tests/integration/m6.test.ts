import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

function zip(entries: Record<string, string>): Buffer {
  const u8: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(entries)) {
    u8[key] = strToU8(value);
  }
  return Buffer.from(zipSync(u8));
}

function multipart(fileBuffer: Buffer, filename: string): { payload: Buffer; boundary: string } {
  const boundary = '----stackpanel-m6-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, fileBuffer, tail]), boundary };
}

function basePluginZip(): Buffer {
  return zip({
    'manifest.json': JSON.stringify({
      id: 'base-plugin',
      name: 'Base Plugin',
      version: '1.0.0',
      permissions: ['demo:read', 'demo:admin'],
      roleTemplates: [{ role: 'USER', permissions: ['demo:read'] }],
      provides: ['demo.extension'],
    }),
    'dist/index.js': `const plugin = {
      manifest: {
        id: 'base-plugin',
        name: 'Base Plugin',
        version: '1.0.0'
      },
      routes: [
        { method: 'GET', path: '/base', auth: 'user', permission: 'demo:read', handler: async () => ({ ok: true }) },
        { method: 'GET', path: '/base-admin', auth: 'user', permission: 'demo:admin', handler: async () => ({ ok: true }) },
        { method: 'GET', path: '/base-public', permission: 'demo:read', handler: async () => ({ ok: true }) },
        { method: 'GET', path: '/base-public-admin', permission: 'demo:admin', handler: async () => ({ ok: true }) }
      ],
      onActivate: (ctx) => {
        ctx.registerExtension('ui.admin.dashboard', { id: 'base-widget', title: 'Base widget' });
      }
    };
    export default plugin;`,
  });
}

function appPluginZip(): Buffer {
  return zip({
    'manifest.json': JSON.stringify({
      id: 'app-plugin',
      name: 'App Plugin',
      version: '1.0.0',
      requires: [{ id: 'base-plugin', range: '1.x' }],
      consumes: [{ pluginId: 'base-plugin', extensionPoint: 'demo.extension' }],
    }),
    'dist/index.js': `const plugin = {
      manifest: {
        id: 'app-plugin',
        name: 'App Plugin',
        version: '1.0.0'
      },
      routes: [
        { method: 'GET', path: '/app', auth: 'user', permission: 'demo:read', handler: async () => ({ ok: true }) }
      ]
    };
    export default plugin;`,
  });
}

function missingDependencyZip(): Buffer {
  return zip({
    'manifest.json': JSON.stringify({
      id: 'bad-deps',
      name: 'Bad Deps',
      version: '1.0.0',
      requires: ['not-installed'],
    }),
    'dist/index.js': `const plugin = { manifest: { id: 'bad-deps', name: 'Bad Deps', version: '1.0.0' }, routes: [] };
    export default plugin;`,
  });
}

describe.skipIf(!dbAvailable)('M6.2 runtime integration (real DB)', () => {
  let app: FastifyInstance;
  let dataDir = '';
  const adminEmail = `m6_admin_${Date.now()}@example.com`;
  const userEmail = `m6_user_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';

  beforeAll(async () => {
    // Temp data dir INSIDE the repo so dynamically-imported plugin dist files
    // resolve bare specifiers (@stackpanel/sdk, zod) via apps/api/node_modules.
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-testdata-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    await prisma.plugin.deleteMany({
      where: { id: { in: ['base-plugin', 'app-plugin', 'bad-deps'] } },
    });
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    adminToken = admin.token;
    userToken = user.token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.plugin.deleteMany({
      where: { id: { in: ['base-plugin', 'app-plugin', 'bad-deps'] } },
    });
    await prisma.user.deleteMany({
      where: { email: { in: [adminEmail, userEmail] } },
    });
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('installs plugins with dependency and RBAC templates', async () => {
    for (const [name, buffer] of [
      ['base-plugin.zip', basePluginZip()],
      ['app-plugin.zip', appPluginZip()],
    ] as const) {
      const { payload, boundary } = multipart(buffer, name);
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
    }
  });

  it('enforces route permissions from active role templates', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/base',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(allowed.statusCode).toBe(200);
    const dependent = await app.inject({
      method: 'GET',
      url: '/app',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(dependent.statusCode).toBe(200);
    const denied = await app.inject({
      method: 'GET',
      url: '/base-admin',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(denied.statusCode).toBe(403);

    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/base-public',
    });
    expect(unauthenticated.statusCode).toBe(401);

    const publicAllowed = await app.inject({
      method: 'GET',
      url: '/base-public',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(publicAllowed.statusCode).toBe(200);

    const publicDenied = await app.inject({
      method: 'GET',
      url: '/base-public-admin',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(publicDenied.statusCode).toBe(403);
  });

  it('checks finder/admin permission strings from active role templates', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/permissions/check?permission=demo:read',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(allowed.statusCode).toBe(200);
    expect((allowed.json() as { allowed: boolean }).allowed).toBe(true);

    const denied = await app.inject({
      method: 'GET',
      url: '/permissions/check?permission=demo:admin',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(denied.statusCode).toBe(200);
    expect((denied.json() as { allowed: boolean }).allowed).toBe(false);

    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/permissions/check?permission=demo:read',
    });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('records frontend audit events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/frontend/audit',
      headers: {
        authorization: `Bearer ${userToken}`,
        'content-type': 'application/json',
      },
      payload: {
        action: 'frontend.finder.call',
        pluginId: 'base-plugin',
        resourceId: 'demo:read',
        meta: { status: 'ok' },
      },
    });
    expect(res.statusCode).toBe(200);

    const prisma = getPrisma();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'frontend.finder.call', resourceId: 'demo:read' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(
      (await prisma.user.findUniqueOrThrow({ where: { email: userEmail } })).id,
    );
  });

  it('exposes dashboard widgets and RBAC templates', async () => {
    const widgets = await app.inject({
      method: 'GET',
      url: '/admin/ui/widgets',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(widgets.statusCode).toBe(200);
    expect(
      (widgets.json() as { widgets: Array<{ id: string }> }).widgets.some(
        (widget) => widget.id === 'base-widget',
      ),
    ).toBe(true);

    const rbac = await app.inject({
      method: 'GET',
      url: '/admin/rbac/templates',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(rbac.statusCode).toBe(200);
    expect(
      (rbac.json() as { templates: Array<{ pluginId: string; permission: string }> }).templates,
    ).toContainEqual({ pluginId: 'base-plugin', permission: 'demo:read' });
  });

  it('protects a required plugin from disable and rejects missing dependencies', async () => {
    const disableBase = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/base-plugin',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(disableBase.statusCode).toBe(409);

    const { payload, boundary } = multipart(missingDependencyZip(), 'bad-deps.zip');
    const bad = await app.inject({
      method: 'POST',
      url: '/admin/plugins/upload',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(bad.statusCode).toBe(409);
  });

  it('allows teardown in dependency order and removes widgets', async () => {
    const disableApp = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/app-plugin',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(disableApp.statusCode).toBe(200);
    const disableBase = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/base-plugin',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: false },
    });
    expect(disableBase.statusCode).toBe(200);

    const widgets = await app.inject({
      method: 'GET',
      url: '/admin/ui/widgets',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect((widgets.json() as { widgets: unknown[] }).widgets).toEqual([]);
  });
});
