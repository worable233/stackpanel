import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { assertNoConflictingFrontendPages, FrontendError } from '../../src/lib/frontend.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

const VALID_CSS = `:root { --background: oklch(1 0 0); --primary: oklch(0.5 0.2 250); }
.dark { --background: oklch(0.15 0.01 250); --primary: oklch(0.6 0.2 250); }`;

const THEME_FRONTEND_MANIFEST = JSON.stringify({
  version: '1.0.0',
  revision: 'theme-revision-1',
  entry: 'frontend/dist/index.js',
  pages: [{ path: '/', component: 'home' }],
  finders: ['theme.home'],
  files: ['frontend/dist/index.js'],
  settingsSchema: {
    groups: [
      {
        id: 'layout',
        label: 'Layout',
        fields: [
          {
            type: 'select',
            name: 'nav',
            label: 'Navigation',
            default: 'single',
            options: [
              { label: 'Single', value: 'single' },
              { label: 'Double', value: 'double' },
            ],
          },
        ],
      },
    ],
  },
});

const PLUGIN_FRONTEND_MANIFEST = JSON.stringify({
  version: '1.0.0',
  revision: 'plugin-revision-1',
  entry: 'frontend/dist/index.js',
  pages: [{ path: '/shop/:id', component: 'product' }],
  finders: ['store.product'],
  adminRoutes: [{ path: '/overview', component: 'admin/overview', nav: { label: 'Overview' } }],
  adminActions: [
    {
      id: 'overview',
      label: 'Open Overview',
      component: 'admin/overview',
      permission: 'demo:admin',
    },
  ],
  files: ['frontend/dist/index.js'],
  settingsSchema: {
    groups: [
      {
        id: 'shop',
        label: 'Shop',
        fields: [{ type: 'boolean', name: 'showMetadata', label: 'Show metadata', default: true }],
      },
    ],
  },
});

describe('frontend page ownership', () => {
  it('rejects overlapping routes from independent plugins', () => {
    expect(() =>
      assertNoConflictingFrontendPages([
        { id: 'catalog', pages: [{ path: '/content/:id', component: 'detail' }] },
        { id: 'editor', pages: [{ path: '/content/new', component: 'create' }] },
      ]),
    ).toThrow(FrontendError);
  });

  it('allows independent routes that cannot match the same path', () => {
    expect(() =>
      assertNoConflictingFrontendPages([
        { id: 'catalog', pages: [{ path: '/catalog/:id', component: 'detail' }] },
        { id: 'support', pages: [{ path: '/support', component: 'home' }] },
      ]),
    ).not.toThrow();
  });
});

function zip(entries: Record<string, string>): Buffer {
  const u8: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(entries)) {
    u8[key] = strToU8(value);
  }
  return Buffer.from(zipSync(u8));
}

function themeZip(): Buffer {
  return zip({
    'theme.json': JSON.stringify({
      id: 'frontend-theme',
      name: 'Frontend Theme',
      version: '1.0.0',
    }),
    'theme.css': VALID_CSS,
    'frontend/manifest.json': THEME_FRONTEND_MANIFEST,
    'frontend/dist/index.js': 'export const frontend = {};',
  });
}

function pluginZip(): Buffer {
  return zip({
    'manifest.json': JSON.stringify({
      id: 'frontend-plugin',
      name: 'Frontend Plugin',
      version: '1.0.0',
      apiVersion: '>=0.4.0',
    }),
    'dist/index.js': `const plugin = { manifest: { id: 'frontend-plugin', name: 'Frontend Plugin', version: '1.0.0' }, routes: [] }; export default plugin;`,
    'frontend/manifest.json': PLUGIN_FRONTEND_MANIFEST,
    'frontend/dist/index.js': 'export const frontend = {};',
  });
}

function multipart(fileBuffer: Buffer, filename: string): { payload: Buffer; boundary: string } {
  const boundary = '----stackpanel-frontend-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, fileBuffer, tail]), boundary };
}

describe.skipIf(!dbAvailable)('frontend package integration (real DB)', () => {
  let app: FastifyInstance;
  let dataDir = '';
  const email = `frontend_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';

  beforeAll(async () => {
    // Temp data dir INSIDE the repo so dynamically-imported plugin dist files
    // resolve bare specifiers (@stackpanel/sdk, zod) via apps/api/node_modules.
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-testdata-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    await prisma.theme.deleteMany({ where: { id: 'frontend-theme' } });
    await prisma.plugin.deleteMany({ where: { id: 'frontend-plugin' } });
    await prisma.setting.deleteMany({
      where: { key: { in: ['theme:frontend-theme', 'plugin:frontend-plugin'] } },
    });
    const admin = await createAdminUser(app, email, password);
    adminToken = admin.token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.theme.deleteMany({ where: { id: 'frontend-theme' } });
    await prisma.plugin.deleteMany({ where: { id: 'frontend-plugin' } });
    await prisma.setting.deleteMany({
      where: { key: { in: ['theme:frontend-theme', 'plugin:frontend-plugin'] } },
    });
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('installs and exposes a theme frontend package', async () => {
    const { payload, boundary } = multipart(themeZip(), 'frontend-theme.zip');
    const install = await app.inject({
      method: 'POST',
      url: '/admin/themes',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(install.statusCode).toBe(201);

    const frontend = await app.inject({ method: 'GET', url: '/themes/frontend-theme/frontend' });
    expect(frontend.statusCode).toBe(200);
    expect((frontend.json() as { available: boolean }).available).toBe(true);
    expect(
      (frontend.json() as { manifest: { pages: Array<{ path: string }>; finders: string[] } })
        .manifest.pages,
    ).toContainEqual({ path: '/', component: 'home' });
    expect(
      (frontend.json() as { manifest: { pages: Array<{ path: string }>; finders: string[] } })
        .manifest.finders,
    ).toContain('theme.home');

    const schema = await app.inject({
      method: 'GET',
      url: '/themes/frontend-theme/settings-schema',
    });
    expect(schema.statusCode).toBe(200);
    expect((schema.json() as { schema: { groups: unknown[] } }).schema.groups.length).toBe(1);
  });

  it('reads defaults and persists theme frontend settings', async () => {
    const before = await app.inject({ method: 'GET', url: '/themes/frontend-theme/settings' });
    expect((before.json() as { settings: { layout: { nav: string } } }).settings.layout.nav).toBe(
      'single',
    );

    const patch = await app.inject({
      method: 'PATCH',
      url: '/admin/themes/frontend-theme/settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { settings: { layout: { nav: 'double' } } },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { settings: { layout: { nav: string } } }).settings.layout.nav).toBe(
      'double',
    );
  });

  it('sets and clears a theme preview without activating it', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/admin/themes/preview',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      payload: { themeId: 'frontend-theme' },
    });
    expect(set.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: '/admin/themes/preview',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect((get.json() as { themeId: string }).themeId).toBe('frontend-theme');

    const clear = await app.inject({
      method: 'DELETE',
      url: '/admin/themes/preview',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(clear.statusCode).toBe(204);
    const cleared = await app.inject({
      method: 'GET',
      url: '/admin/themes/preview',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect((cleared.json() as { themeId: string | null }).themeId).toBeNull();
  });

  it('installs and exposes a plugin frontend package', async () => {
    const { payload, boundary } = multipart(pluginZip(), 'frontend-plugin.zip');
    const install = await app.inject({
      method: 'POST',
      url: '/admin/plugins/upload',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(install.statusCode).toBe(201);

    const frontend = await app.inject({ method: 'GET', url: '/plugins/frontend-plugin/frontend' });
    expect(frontend.statusCode).toBe(200);
    expect((frontend.json() as { available: boolean }).available).toBe(true);
    expect(
      (frontend.json() as { manifest: { pages: Array<{ path: string }>; finders: string[] } })
        .manifest.pages,
    ).toContainEqual({ path: '/shop/:id', component: 'product' });

    const enable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/frontend-plugin',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);

    const frontends = await app.inject({ method: 'GET', url: '/plugins/frontends' });
    expect(frontends.statusCode).toBe(200);
    expect(
      (frontends.json() as { plugins: Array<{ id: string }> }).plugins.some(
        (plugin) => plugin.id === 'frontend-plugin',
      ),
    ).toBe(true);

    const actions = await app.inject({
      method: 'GET',
      url: '/admin/ui/actions',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(actions.statusCode).toBe(200);
    expect(
      (actions.json() as { actions: Array<{ id: string; pluginId: string }> }).actions,
    ).toContainEqual({
      id: 'overview',
      label: 'Open Overview',
      component: 'admin/overview',
      permission: 'demo:admin',
      pluginId: 'frontend-plugin',
    });

    const patch = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/frontend-plugin/settings',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { settings: { shop: { showMetadata: false } } },
    });
    expect(patch.statusCode).toBe(200);
    expect(
      (patch.json() as { settings: { shop: { showMetadata: boolean } } }).settings.shop
        .showMetadata,
    ).toBe(false);
  });

  it('rejects frontend source files outside dist', async () => {
    const { payload, boundary } = multipart(
      zip({
        'theme.json': JSON.stringify({ id: 'bad-frontend', name: 'Bad', version: '1.0.0' }),
        'theme.css': VALID_CSS,
        'frontend/manifest.json': THEME_FRONTEND_MANIFEST,
        'frontend/src/index.tsx': 'export default null;',
      }),
      'bad-frontend.zip',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/admin/themes',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(422);
  });
});
