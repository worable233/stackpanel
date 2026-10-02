import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
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

function zip(entries: Record<string, string>): Buffer {
  const u8: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(entries)) {
    u8[key] = strToU8(value);
  }
  return Buffer.from(zipSync(u8));
}

function multipart(fileBuffer: Buffer, filename: string): { payload: Buffer; boundary: string } {
  const boundary = '----stackpanel-signing-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, fileBuffer, tail]), boundary };
}

function themeZip(id: string): Buffer {
  return zip({
    'theme.json': JSON.stringify({ id, name: 'Signing Theme', version: '1.0.0' }),
    'theme.css': ':root { --background: oklch(1 0 0); }',
  });
}

function pluginZip(id: string): Buffer {
  return zip({
    'manifest.json': JSON.stringify({
      id,
      name: 'Signing Plugin',
      version: '1.0.0',
      apiVersion: '>=0.4.0',
    }),
    'dist/index.js': `const plugin = { manifest: { id: '${id}', name: 'Signing Plugin', version: '1.0.0' }, routes: [] }; export default plugin;`,
  });
}

function signedZip(entries: Record<string, string>, privateKey: KeyObject): Buffer {
  const files: Record<string, Uint8Array> = {};
  const hashes: Record<string, string> = {};
  for (const name of Object.keys(entries).sort()) {
    const value = entries[name];
    if (typeof value !== 'string') continue;
    const data = strToU8(value);
    files[name] = data;
    hashes[name] = createHash('sha256').update(data).digest('hex');
  }
  const payload = Buffer.from(JSON.stringify({ algorithm: 'ed25519', files: hashes }), 'utf8');
  const signature = sign(null, payload, privateKey).toString('base64');
  files['signature.json'] = strToU8(
    `${JSON.stringify({ algorithm: 'ed25519', files: hashes, signature }, null, 2)}\n`,
  );
  return Buffer.from(zipSync(files));
}

describe.skipIf(!dbAvailable)('signing key management integration (real DB)', () => {
  let app: FastifyInstance;
  let dataDir = '';
  const email = `signing_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let publicKeyPem = '';
  let privateKey: KeyObject;

  beforeAll(async () => {
    // Temp data dir INSIDE the repo so dynamically-imported plugin dist files
    // resolve bare specifiers (@stackpanel/sdk, zod) via apps/api/node_modules.
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-testdata-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    await prisma.theme.deleteMany({ where: { id: { in: ['m7-theme', 'm7-theme-open'] } } });
    await prisma.plugin.deleteMany({ where: { id: 'm7-plugin' } });
    await prisma.setting.deleteMany({ where: { key: 'signing.publicKey' } });
    const admin = await createAdminUser(app, email, password);
    adminToken = admin.token;
    const keys = generateKeyPairSync('ed25519');
    publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    privateKey = createPrivateKey(keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.theme.deleteMany({ where: { id: { in: ['m7-theme', 'm7-theme-open'] } } });
    await prisma.plugin.deleteMany({ where: { id: 'm7-plugin' } });
    await prisma.setting.deleteMany({ where: { key: 'signing.publicKey' } });
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('stores a signing key and enforces it for theme and plugin uploads', async () => {
    const initial = await app.inject({
      method: 'GET',
      url: '/admin/signing',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(initial.statusCode).toBe(200);
    expect((initial.json() as { signing: { source: string } }).signing.source).toBe('disabled');

    const invalid = await app.inject({
      method: 'PATCH',
      url: '/admin/signing',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { publicKey: 'not-a-key' },
    });
    expect(invalid.statusCode).toBe(422);

    const patch = await app.inject({
      method: 'PATCH',
      url: '/admin/signing',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { publicKey: publicKeyPem },
    });
    expect(patch.statusCode).toBe(200);
    expect(
      (patch.json() as { signing: { source: string; configured: boolean } }).signing,
    ).toMatchObject({ source: 'stored', configured: true });

    const theme = multipart(themeZip('m7-theme'), 'm7-theme.zip');
    const unsignedTheme = await app.inject({
      method: 'POST',
      url: '/admin/themes',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${theme.boundary}`,
      },
      payload: theme.payload,
    });
    expect(unsignedTheme.statusCode).toBe(422);

    const plugin = multipart(pluginZip('m7-plugin'), 'm7-plugin.zip');
    const unsignedPlugin = await app.inject({
      method: 'POST',
      url: '/admin/plugins/upload',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${plugin.boundary}`,
      },
      payload: plugin.payload,
    });
    expect(unsignedPlugin.statusCode).toBe(422);

    const signedTheme = multipart(
      signedZip(
        {
          'theme.json': JSON.stringify({
            id: 'm7-theme',
            name: 'Signing Theme',
            version: '1.0.0',
          }),
          'theme.css': ':root { --background: oklch(1 0 0); }',
        },
        privateKey,
      ),
      'm7-theme.zip',
    );
    const signedUpload = await app.inject({
      method: 'POST',
      url: '/admin/themes',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${signedTheme.boundary}`,
      },
      payload: signedTheme.payload,
    });
    expect(signedUpload.statusCode).toBe(201);

    const clear = await app.inject({
      method: 'PATCH',
      url: '/admin/signing',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { publicKey: '' },
    });
    expect(clear.statusCode).toBe(200);
    expect((clear.json() as { signing: { source: string } }).signing.source).toBe('disabled');

    const openTheme = multipart(themeZip('m7-theme-open'), 'm7-theme-open.zip');
    const openUpload = await app.inject({
      method: 'POST',
      url: '/admin/themes',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${openTheme.boundary}`,
      },
      payload: openTheme.payload,
    });
    expect(openUpload.statusCode).toBe(201);
  });
});
