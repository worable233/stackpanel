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

const VALID_CSS = `:root { --background: oklch(1 0 0); --primary: oklch(0.5 0.2 250); }
.dark { --background: oklch(0.15 0.01 250); --primary: oklch(0.6 0.2 250); }`;

function zip(entries: Record<string, string>): Buffer {
  const u8: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(entries)) {
    u8[key] = strToU8(value);
  }
  return Buffer.from(zipSync(u8));
}

function themeZip(overrides: Record<string, string> = {}): Buffer {
  return zip({
    'theme.json': JSON.stringify({ id: 'ocean', name: 'Ocean', version: '1.0.0' }),
    'theme.css': VALID_CSS,
    'assets/logo.svg': '<svg/>',
    ...overrides,
  });
}

function zipToMultipart(
  fileBuffer: Buffer,
  filename: string,
): { payload: Buffer; boundary: string } {
  const boundary = '----stackpanel-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, fileBuffer, tail]), boundary };
}

describe.skipIf(!dbAvailable)('theme engine integration (real DB)', () => {
  let app: FastifyInstance;
  let dataDir = '';
  const adminEmail = `theme_admin_${Date.now()}@example.com`;
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
    const admin = await createAdminUser(app, adminEmail, password);
    adminToken = admin.token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.theme.deleteMany({});
    await prisma.user.deleteMany({ where: { email: adminEmail } });
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('seeds the default theme as active on boot', async () => {
    const res = await app.inject({ method: 'GET', url: '/themes' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      themes: Array<{ id: string; active: boolean; isDefault?: boolean }>;
    };
    const def = body.themes.find((t) => t.id === 'default');
    expect(def).toBeTruthy();
    expect(def?.active).toBe(true);
    const active = await app.inject({ method: 'GET', url: '/themes/active' });
    expect((active.json() as { theme: { id: string } }).theme.id).toBe('default');
  });

  it('serves the default theme css', async () => {
    const res = await app.inject({ method: 'GET', url: '/themes/default/theme.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.body).toContain('--primary');
  });

  it('installs a valid theme ZIP', async () => {
    const { payload, boundary } = zipToMultipart(themeZip(), 'ocean.zip');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/themes',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const theme = (res.json() as { theme: { id: string; name: string } }).theme;
    expect(theme.id).toBe('ocean');
  });

  it('rejects a ZIP missing theme.css', async () => {
    const { payload, boundary } = zipToMultipart(
      zip({ 'theme.json': JSON.stringify({ id: 'bad', name: 'Bad', version: '1' }) }),
      'bad.zip',
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

  it('rejects a ZIP with an executable file', async () => {
    const { payload, boundary } = zipToMultipart(
      zip({
        'theme.json': JSON.stringify({ id: 'bad2', name: 'Bad2', version: '1' }),
        'theme.css': VALID_CSS,
        'script.js': 'alert(1)',
      }),
      'bad2.zip',
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

  it('rejects a ZIP with a path-traversal entry', async () => {
    const { payload, boundary } = zipToMultipart(
      zip({
        'theme.json': JSON.stringify({ id: 'bad3', name: 'Bad3', version: '1' }),
        '../evil.txt': 'x',
        'theme.css': VALID_CSS,
      }),
      'bad3.zip',
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

  it('rejects CSS containing non-token rules', async () => {
    const { payload, boundary } = zipToMultipart(
      zip({
        'theme.json': JSON.stringify({ id: 'bad4', name: 'Bad4', version: '1' }),
        'theme.css': `:root { --x: 1; } .evil { color: red; }`,
      }),
      'bad4.zip',
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

  it('rejects CSS tokens with backslash-escaped url()', async () => {
    const { payload, boundary } = zipToMultipart(
      zip({
        'theme.json': JSON.stringify({ id: 'bad5', name: 'Bad5', version: '1' }),
        'theme.css': `:root { --img: '\\75 rl(x)'; }`,
      }),
      'bad5.zip',
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

  it('activates a theme and keeps a single active theme', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/themes/ocean',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { active: true },
    });
    expect(res.statusCode).toBe(200);
    const themes = await app.inject({ method: 'GET', url: '/themes' });
    const rows = (themes.json() as { themes: Array<{ id: string; active: boolean }> }).themes;
    expect(rows.filter((t) => t.active).length).toBe(1);
    expect(rows.find((t) => t.id === 'ocean')?.active).toBe(true);
  });

  it('serves the installed theme css with the new tokens', async () => {
    const res = await app.inject({ method: 'GET', url: '/themes/ocean/theme.css' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('oklch(1 0 0)');
  });

  it('serves theme assets from the installed directory', async () => {
    const res = await app.inject({ method: 'GET', url: '/themes/ocean/assets/logo.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<svg/>');
    const missing = await app.inject({ method: 'GET', url: '/themes/ocean/assets/nope.png' });
    expect(missing.statusCode).toBe(404);
  });

  it('protects the default and active themes from deletion', async () => {
    const def = await app.inject({
      method: 'DELETE',
      url: '/admin/themes/default',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(def.statusCode).toBe(400);
    const active = await app.inject({
      method: 'DELETE',
      url: '/admin/themes/ocean',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(active.statusCode).toBe(400);
  });

  it('deletes an inactive non-default theme', async () => {
    const { payload, boundary } = zipToMultipart(
      zip({
        'theme.json': JSON.stringify({ id: 'forest', name: 'Forest', version: '1.0.0' }),
        'theme.css': VALID_CSS,
      }),
      'forest.zip',
    );
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

    const del = await app.inject({
      method: 'DELETE',
      url: '/admin/themes/forest',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(del.statusCode).toBe(204);
    const themes = await app.inject({ method: 'GET', url: '/themes' });
    const ids = (themes.json() as { themes: Array<{ id: string }> }).themes.map((t) => t.id);
    expect(ids).not.toContain('forest');
  });
});
