/**
 * Media library admin surface (`/media/admin/*`, ADR-0014 §2).
 *
 * The `media-library` plugin bridges its own routes here with the caller's
 * session token, so this suite doubles as the contract test for that console:
 * cross-owner listing with facets, aggregate counters + encoder health, and the
 * explicit repair path for `failed` variants (terminal by design).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getStorage } from '../../src/infra.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/** A real, decodable PNG so variant planning/encoding has something to chew on. */
async function realPng(width: number, height: number): Promise<Buffer> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 90, b: 180 } },
  })
    .png()
    .toBuffer();
  return Buffer.from(buf);
}

interface AdminListResponse {
  items: Array<{ id: string; filename: string; mime: string; visibility: string }>;
  total: number;
  page: number;
  pageSize: number;
}

interface AdminStatsResponse {
  stats: {
    total: number;
    bytes: number;
    byVisibility: { public: number; private: number };
    byKind: Record<string, number>;
    variants: { pending: number; ready: number; failed: number };
  };
  encoder: { available: boolean; error?: string };
}

describe.skipIf(!dbAvailable)('media admin surface (real DB + local storage)', () => {
  let app: FastifyInstance;
  let dataDir = '';
  const suffix = Date.now();
  const ownerEmail = `media_lib_owner_${suffix}@example.com`;
  const otherEmail = `media_lib_other_${suffix}@example.com`;
  const adminEmail = `media_lib_admin_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let ownerToken = '';
  let adminToken = '';
  let ownerId = '';
  let otherId = '';
  let adminId = '';

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-media-lib-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const owner = await createTestUser(app, ownerEmail, password);
    const other = await createTestUser(app, otherEmail, password);
    const admin = await createAdminUser(app, adminEmail, password);
    ownerToken = owner.token;
    adminToken = admin.token;
    ownerId = owner.userId;
    otherId = other.userId;
    adminId = admin.userId;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    await prisma.attachment.deleteMany({ where: { ownerId: { in: [ownerId, otherId, adminId] } } });
    await prisma.user.deleteMany({
      where: { email: { in: [ownerEmail, otherEmail, adminEmail] } },
    });
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function upload(token: string, body: Buffer, query = ''): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/media${query}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { attachment: { id: string } }).attachment.id;
  }

  function list(token: string, query: string): Promise<{
    statusCode: number;
    json: AdminListResponse;
  }> {
    return app
      .inject({
        method: 'GET',
        url: `/media/admin/attachments${query}`,
        headers: { authorization: `Bearer ${token}` },
      })
      .then((res) => ({ statusCode: res.statusCode, json: res.json() as AdminListResponse }));
  }

  it('is closed to non-admins', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/media/admin/attachments',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(listRes.statusCode).toBe(403);
    const statsRes = await app.inject({
      method: 'GET',
      url: '/media/admin/stats',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(statsRes.statusCode).toBe(403);
    const anon = await app.inject({ method: 'GET', url: '/media/admin/attachments' });
    expect(anon.statusCode).toBe(401);
    const rebuild = await app.inject({
      method: 'POST',
      url: '/media/admin/variants/rebuild',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {},
    });
    expect(rebuild.statusCode).toBe(403);
  });

  it('lists across owners with pagination and facets', async () => {
    const a = await upload(ownerToken, await realPng(1400, 900), '?filename=lib-a.png');
    const b = await upload(ownerToken, await realPng(1200, 800), '?filename=lib-b.png');

    const page = await list(adminToken, '?page=1&pageSize=1');
    expect(page.statusCode).toBe(200);
    expect(page.json.items).toHaveLength(1);
    expect(page.json.pageSize).toBe(1);
    expect(page.json.total).toBeGreaterThanOrEqual(2);

    const images = await list(adminToken, '?kind=image&pageSize=100&q=lib-');
    expect(images.json.items.length).toBeGreaterThanOrEqual(2);
    expect(images.json.items.every((item) => item.mime.startsWith('image/'))).toBe(true);
    const ids = images.json.items.map((item) => item.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);

    const narrowed = await list(adminToken, '?kind=image&q=lib-a&pageSize=100');
    expect(narrowed.json.items.map((item) => item.id)).toEqual([a]);
    expect(narrowed.json.total).toBe(1);

    const documents = await list(adminToken, '?kind=document&pageSize=100&q=lib-');
    expect(documents.json.items).toHaveLength(0);

    const bad = await list(adminToken, '?kind=nope');
    expect(bad.statusCode).toBe(400);
  });

  it('reports aggregate stats and encoder health', async () => {
    await upload(ownerToken, await realPng(1000, 700), '?filename=stats.png');
    const res = await app.inject({
      method: 'GET',
      url: '/media/admin/stats',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AdminStatsResponse;
    expect(body.stats.total).toBeGreaterThanOrEqual(3);
    expect(body.stats.bytes).toBeGreaterThan(0);
    expect(body.stats.byKind['image']).toBeGreaterThanOrEqual(3);
    expect(body.stats.byVisibility.public + body.stats.byVisibility.private).toBe(body.stats.total);
    // vitest resolves sharp correctly, so the encoder must be usable here.
    expect(body.encoder.available).toBe(true);
  });

  it('lets an admin publish and delete any attachment', async () => {
    const id = await upload(ownerToken, await realPng(800, 600), '?filename=admin-publish.png');

    const anonymousBefore = await app.inject({ method: 'GET', url: `/media/${id}/content` });
    expect(anonymousBefore.statusCode).toBe(403);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/media/${id}`,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { visibility: 'public' },
    });
    expect(patched.statusCode).toBe(200);
    const anonymousAfter = await app.inject({ method: 'GET', url: `/media/${id}/content` });
    expect(anonymousAfter.statusCode).toBe(200);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/media/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleted.statusCode).toBe(200);
    const gone = await app.inject({
      method: 'GET',
      url: `/media/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(gone.statusCode).toBe(404);
  });

  it('re-queues failed variants (terminal state repair)', async () => {
    const prisma = getPrisma();
    const id = await upload(ownerToken, await realPng(2000, 1200), '?filename=repair.png');

    // Force the "encoder outage" shape: every variant terminal `failed`.
    const row = await prisma.attachment.findUnique({ where: { id } });
    const failed = (row?.variants as Array<Record<string, unknown>>).map((variant) => ({
      ...variant,
      status: 'failed',
      attempts: 3,
      error: '编码未产出字节',
      size: 0,
    }));
    await prisma.attachment.update({ where: { id }, data: { variants: failed } });

    const res = await app.inject({
      method: 'POST',
      url: '/media/admin/variants/rebuild',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { attachmentId: id },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { requeued: number }).requeued).toBe(1);

    const after = await prisma.attachment.findUnique({ where: { id } });
    // A variant without an explicit `status` is a Stage A (inline) variant, i.e.
    // ready — the same default `variantStatus()` applies.
    const statuses = (after?.variants as Array<{ status?: string }>).map(
      (variant) => variant.status ?? 'ready',
    );
    // Pending when the async worker has not run yet, ready once it has — never
    // `failed` again.
    expect(statuses.every((status) => status === 'pending' || status === 'ready')).toBe(true);
  });

  it('delivers uploads as lossless WebP when that saves bytes', async () => {
    // A flat-colour PNG is exactly the case the delivery encode wins: identical
    // pixels, fewer bytes. Sharp is real here, so this also pins the encoder path
    // that the unit tests stub out.
    const source = await realPng(1400, 900);
    const res = await app.inject({
      method: 'POST',
      url: '/media?filename=delivery.png',
      headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'image/png' },
      payload: source,
    });
    expect(res.statusCode).toBe(201);
    const attachment = (res.json() as {
      attachment: { id: string; mime: string; filename: string; size: number };
    }).attachment;
    expect(attachment.mime).toBe('image/webp');
    expect(attachment.filename).toBe('delivery.webp');
    expect(attachment.size).toBeLessThan(source.length);

    const content = await app.inject({
      method: 'GET',
      url: `/media/${attachment.id}/content`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(content.statusCode).toBe(200);
    expect(String(content.headers['content-type'])).toContain('image/webp');
  });

  it('batch-converts stored attachments and is a no-op once converted', async () => {
    const png = await realPng(1400, 900);
    const prisma = getPrisma();
    // Fabricate a pre-feature row: PNG bytes on disk, PNG mime, no delivery encode.
    const id = `att_legacy_${suffix}`;
    const key = `media/2025/01/${id}/original.png`;
    await getStorage().put(key, new Uint8Array(png), {
      contentType: 'image/png',
      public: false,
    });
    await prisma.attachment.create({
      data: {
        id,
        key,
        filename: 'legacy.png',
        mime: 'image/png',
        size: png.length,
        ownerId,
        visibility: 'private',
        variants: [],
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/media/admin/optimize',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { attachmentId: id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      optimized: number;
      skipped: number;
      savedBytes: number;
      ids: string[];
    };
    expect(body.ids).toEqual([id]);
    expect(body.savedBytes).toBeGreaterThan(0);

    const after = await prisma.attachment.findUnique({ where: { id } });
    expect(after?.mime).toBe('image/webp');
    expect(after?.filename).toBe('legacy.webp');
    expect(after?.key.endsWith('original.webp')).toBe(true);
    // The superseded PNG object is gone, not orphaned.
    expect(await getStorage().get(key)).toBeNull();

    // Second run: the row has left the candidate set, nothing is re-encoded.
    const again = await app.inject({
      method: 'POST',
      url: '/media/admin/optimize',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { attachmentId: id },
    });
    expect((again.json() as { optimized: number }).optimized).toBe(0);
  });

  it('keeps published links valid across a conversion and revalidates them', async () => {
    // The link contract this feature turns on: a media URL is identity-based, so
    // converting the bytes in place must neither break the URL nor leave a stale
    // copy stranded behind it.
    const png = await realPng(1400, 900);
    const prisma = getPrisma();
    const id = `att_link_${suffix}`;
    const key = `media/2025/01/${id}/original.png`;
    await getStorage().put(key, new Uint8Array(png), {
      contentType: 'image/png',
      public: false,
    });
    await prisma.attachment.create({
      data: {
        id,
        key,
        filename: 'link.png',
        mime: 'image/png',
        size: png.length,
        ownerId,
        visibility: 'public',
        variants: [],
      },
    });

    const before = await app.inject({ method: 'GET', url: `/media/${id}/content` });
    expect(before.statusCode).toBe(200);
    expect(String(before.headers['content-type'])).toContain('image/png');
    expect(String(before.headers['cache-control'])).toBe('public, max-age=0, must-revalidate');
    const oldEtag = String(before.headers['etag']);
    expect(oldEtag).toMatch(/^W\/"[0-9a-f]{16}"$/);

    const optimized = await app.inject({
      method: 'POST',
      url: '/media/admin/optimize',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { attachmentId: id },
    });
    expect((optimized.json() as { optimized: number }).optimized).toBe(1);

    // Same URL, no redirect, no 404 — and now the converted bytes.
    const after = await app.inject({ method: 'GET', url: `/media/${id}/content` });
    expect(after.statusCode).toBe(200);
    expect(String(after.headers['content-type'])).toContain('image/webp');
    const newEtag = String(after.headers['etag']);
    expect(newEtag).not.toBe(oldEtag);

    // A cache holding the pre-conversion copy is told it is out of date…
    const stale = await app.inject({
      method: 'GET',
      url: `/media/${id}/content`,
      headers: { 'if-none-match': oldEtag },
    });
    expect(stale.statusCode).toBe(200);
    expect(String(stale.headers['content-type'])).toContain('image/webp');
    // …while one that is already current costs a single empty 304.
    const fresh = await app.inject({
      method: 'GET',
      url: `/media/${id}/content`,
      headers: { 'if-none-match': newEtag },
    });
    expect(fresh.statusCode).toBe(304);
    expect(fresh.body).toBe('');

    // Opting into `?v=<rev>` upgrades the very same URL to immutable caching; a
    // stale `v` is not an identity check, so the link still resolves.
    const meta = await app.inject({
      method: 'GET',
      url: `/media/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const rev = (meta.json() as { attachment: { rev: string } }).attachment.rev;
    expect(`W/"${rev}"`).toBe(newEtag);
    const versioned = await app.inject({ method: 'GET', url: `/media/${id}/content?v=${rev}` });
    expect(versioned.statusCode).toBe(200);
    expect(String(versioned.headers['cache-control'])).toBe('public, max-age=31536000, immutable');
    const staleVersion = await app.inject({ method: 'GET', url: `/media/${id}/content?v=deadbeef` });
    expect(staleVersion.statusCode).toBe(200);
    expect(String(staleVersion.headers['cache-control'])).toBe(
      'public, max-age=0, must-revalidate',
    );
  });

  it('closes the WebP batch to non-admins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/media/admin/optimize',
      headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});
