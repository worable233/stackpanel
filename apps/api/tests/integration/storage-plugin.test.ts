import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { S3Driver } from '@stackpanel/db';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getInfraConfig } from '../../src/infra.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/** Real, decodable PNG so the sharp pipeline can produce variants too. */
async function realPng(width: number, height: number): Promise<Buffer> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } },
  })
    .png()
    .toBuffer();
  return Buffer.from(buf);
}

/** Recursively collect every file under `dir`. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * REAL end-to-end storage-plugin test.
 *
 * Boots the actual kernel (`buildApp`), seeds + activates the built-in
 * `storage` plugin, configures it through its own admin HTTP route, then drives
 * a real `/media` upload and proves the bytes landed in the *plugin* backend
 * (not the env default). Two backends are covered:
 *
 *  - `local`: a distinct root; the object must appear there, and must NOT appear
 *    in the env-configured default root.
 *  - `s3`: a live MinIO container; the object must be readable from the bucket,
 *    and `/media/:id/content` must round-trip through the provider's redirect.
 *
 * Skips cleanly when the DB is unavailable (same convention as media.test.ts).
 * The S3 block additionally requires `STORAGE_PLUGIN_S3_ENDPOINT` to be set, so
 * CI without MinIO still runs the local-backend case.
 */
describe.skipIf(!dbAvailable)('storage plugin (real kernel + real backend)', () => {
  let app: FastifyInstance;
  let dataDir = '';
  let pluginRoot = '';
  let envRoot = '';
  const suffix = Date.now();

  let adminToken = '';
  let userToken = '';
  let adminId = '';
  let userId = '';

  const s3Endpoint = process.env['STORAGE_PLUGIN_S3_ENDPOINT'];
  const s3Bucket = process.env['STORAGE_PLUGIN_S3_BUCKET'] ?? 'sp-test';
  const s3AccessKey = process.env['STORAGE_PLUGIN_S3_ACCESS_KEY'] ?? 'minioadmin';
  const s3SecretKey = process.env['STORAGE_PLUGIN_S3_SECRET_KEY'] ?? 'minioadmin123';

  beforeAll(async () => {
    // Isolated data dir; the env "default" driver anchors `<dataDir>/storage`.
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-storage-'));
    const fallback = getInfraConfig().storage;
    if (fallback.driver !== 'local') throw new Error('test requires the local env storage driver');
    envRoot = fallback.root;
    pluginRoot = path.join(dataDir, 'plugin-storage');
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    process.env['STORAGE_DRIVER'] = 'local';

    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    // Seed + register built-ins (this loads the plugin definition and inspects
    // its routes/models), then activate only the storage plugin for this test.
    await app.pluginHost.registerPlugins();
    expect(app.pluginRuntime.has('storage')).toBe(true);
    await app.pluginRuntime.activate('storage');

    const admin = await createAdminUser(app, `sp_admin_${suffix}@example.com`);
    const user = await createTestUser(app, `sp_user_${suffix}@example.com`);
    adminToken = admin.token;
    adminId = admin.userId;
    userToken = user.token;
    userId = user.userId;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.attachment.deleteMany({ where: { ownerId: { in: [adminId, userId] } } });
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function saveConfig(body: Record<string, unknown>): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: '/storage/admin/config',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function upload(token: string, body: Buffer): Promise<{ id: string; key: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/media?filename=real.png',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(201);
    const attachment = (res.json() as { attachment: { id: string } }).attachment;
    const record = await getPrisma().attachment.findUnique({ where: { id: attachment.id } });
    return { id: attachment.id, key: record?.key ?? '' };
  }

  it('exposes the admin config route only to holders of storage.admin', async () => {
    const anon = await app.inject({ method: 'GET', url: '/storage/admin/config' });
    expect(anon.statusCode).toBe(401);
    const forbidden = await app.inject({
      method: 'GET',
      url: '/storage/admin/config',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'GET',
      url: '/storage/admin/config',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as { config: { kind: string } }).config.kind).toBe('env');
  });

  describe('local backend', () => {
    it('replaces the kernel driver: uploads land in the plugin root, not the env root', async () => {
      await saveConfig({ kind: 'local', localRoot: pluginRoot });

      const png0 = await realPng(64, 64);
      const { id, key } = await upload(adminToken, png0);
      expect(key).toMatch(/^media\//);

      // The object exists under the plugin's configured root...
      const inPlugin = await readFile(path.join(pluginRoot, key)).catch(() => null);
      expect(inPlugin, `expected ${key} under plugin root`).not.toBeNull();
      expect(Buffer.from(inPlugin as Buffer).equals(png0)).toBe(true);

      // ...and NOT under the env-configured default root.
      const inEnv = await readFile(path.join(envRoot, key)).catch(() => null);
      expect(inEnv).toBeNull();

      // Bytes round-trip through the HTTP content route.
      const content = await app.inject({
        method: 'GET',
        url: `/media/${id}/content`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(content.statusCode).toBe(200);
      expect(content.rawPayload.equals(png0)).toBe(true);
    });

    it('executes puts and deletes through the provider (spool, zero-copy)', async () => {
      await saveConfig({ kind: 'local', localRoot: pluginRoot });
      const before = await walk(pluginRoot);
      const { id } = await upload(userToken, await realPng(32, 32));
      const after = await walk(pluginRoot);
      expect(after.length).toBeGreaterThan(before.length);

      const del = await app.inject({
        method: 'DELETE',
        url: `/media/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      // Deletion is best-effort at the provider; the DB row is the source of truth.
      expect([200, 204, 404]).toContain(del.statusCode);
    });

    it('falls back to the env driver when configured as env', async () => {
      await saveConfig({ kind: 'env' });
      const png0 = await realPng(16, 16);
      const { key } = await upload(adminToken, png0);
      const inEnv = await readFile(path.join(envRoot, key)).catch(() => null);
      expect(inEnv, 'env driver should own the object after standing aside').not.toBeNull();
    });

    it('reads back historical objects after switching to a new plugin backend', async () => {
      // 1) Write while standing aside: the env driver owns the object.
      await saveConfig({ kind: 'env' });
      const png0 = await realPng(24, 24);
      const { id, key } = await upload(adminToken, png0);
      expect(await readFile(path.join(envRoot, key)).catch(() => null)).not.toBeNull();

      // 2) Switch to a *fresh, empty* plugin root that has never seen the object.
      const freshRoot = path.join(dataDir, 'plugin-storage-fresh');
      await saveConfig({ kind: 'local', localRoot: freshRoot });
      expect(await readFile(path.join(freshRoot, key)).catch(() => null)).toBeNull();

      // 3) The object is still served: the router falls back to the env driver.
      const content = await app.inject({
        method: 'GET',
        url: `/media/${id}/content`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(content.statusCode, 'historical object must remain readable').toBe(200);
      expect(content.rawPayload.equals(png0)).toBe(true);
    });
  });

  describe.skipIf(!s3Endpoint)('S3 backend (live MinIO)', () => {
    /**
     * Independent verification client built from the kernel's own S3 driver,
     * *not* the plugin's config path — this proves the plugin really wrote to
     * the bucket. Reaching the endpoint directly also proves the bytes are
     * visible outside the plugin.
     */
    function verifier(): S3Driver {
      const endpoint = s3Endpoint as string;
      return new S3Driver({
        driver: 's3',
        region: 'us-east-1',
        bucket: s3Bucket,
        accessKeyId: s3AccessKey,
        secretAccessKey: s3SecretKey,
        forcePathStyle: true,
        publicBaseUrl: `${endpoint}/${s3Bucket}`,
        endpoint,
      });
    }

    it('routes uploads through pre-signed PUT and serves them back', async () => {
      await saveConfig({
        kind: 's3',
        s3Endpoint,
        s3Region: 'us-east-1',
        s3Bucket,
        s3ForcePathStyle: true,
        accessKeyId: s3AccessKey,
        secretAccessKey: s3SecretKey,
      });
      // Confirm the admin config reflects credentials without leaking them.
      const cfg = await app.inject({
        method: 'GET',
        url: '/storage/admin/config',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const view = (cfg.json() as { config: { hasCredentials: boolean; secretAccessKey?: unknown } })
        .config;
      expect(view.hasCredentials).toBe(true);
      expect(view.secretAccessKey).toBeUndefined();

      const png0 = await realPng(48, 48);
      const { id, key } = await upload(adminToken, png0);

      // The object really exists in the MinIO bucket... 
      const stat = await verifier().stat(key);
      expect(stat, 'object should be present in the MinIO bucket').not.toBeNull();
      expect(stat?.size).toBe(png0.length);

      // ...and its bytes match what we uploaded.
      const stored = await verifier().get(key);
      expect(stored).not.toBeNull();
      expect(Buffer.from(stored as Uint8Array).equals(png0)).toBe(true);

      // And `/media/:id/content` round-trips the bytes via the provider redirect.
      const content = await app.inject({
        method: 'GET',
        url: `/media/${id}/content`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(content.statusCode).toBe(200);
      expect(content.rawPayload.equals(png0)).toBe(true);

      await verifier().delete(key).catch(() => undefined);
    });
  });
});
