import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/** A minimal, valid PNG header (IHDR only) with the given intrinsic size. */
function png(width: number, height: number): Buffer {
  const out = Buffer.alloc(64);
  out.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  out.writeUInt32BE(13, 8);
  out.write('IHDR', 12, 'ascii');
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}

/** A real, decodable PNG so the sharp pipeline can actually produce variants. */
async function realPng(width: number, height: number): Promise<Buffer> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  return Buffer.from(buf);
}

describe.skipIf(!dbAvailable)('media HTTP surface (real DB + local storage)', () => {
  let app: FastifyInstance;
  let dataDir = '';
  const suffix = Date.now();
  const ownerEmail = `media_owner_${suffix}@example.com`;
  const otherEmail = `media_other_${suffix}@example.com`;
  const adminEmail = `media_admin_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let ownerToken = '';
  let otherToken = '';
  let adminToken = '';
  let ownerId = '';
  let otherId = '';
  let adminId = '';

  beforeAll(async () => {
    // Isolated local storage root: STORAGE_DRIVER defaults to local in dev and
    // anchors a `<dataDir>/storage` root, so the bytes never touch the repo.
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-media-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const owner = await createTestUser(app, ownerEmail, password);
    const other = await createTestUser(app, otherEmail, password);
    const admin = await createAdminUser(app, adminEmail, password);
    ownerToken = owner.token;
    otherToken = other.token;
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

  async function upload(
    token: string,
    body: Buffer,
    query = '',
  ): Promise<{ id: string; res: Awaited<ReturnType<FastifyInstance['inject']>> }> {
    const res = await app.inject({
      method: 'POST',
      url: `/media${query}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
      payload: body,
    });
    return { id: (res.json() as { attachment?: { id: string } }).attachment?.id ?? '', res };
  }

  it('requires authentication to upload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/media',
      headers: { 'content-type': 'image/png' },
      payload: png(4, 4),
    });
    expect(res.statusCode).toBe(401);
  });

  it('uploads a PNG, detects type/dimensions, and serves the bytes back', async () => {
    const { id, res } = await upload(ownerToken, png(3000, 1500), '?filename=hero.png');
    expect(res.statusCode).toBe(201);
    const attachment = (res.json() as { attachment: Record<string, unknown> }).attachment;
    expect(attachment['mime']).toBe('image/png');
    expect(attachment['width']).toBe(3000);
    expect(attachment['height']).toBe(1500);
    expect(attachment['filename']).toBe('hero.png');
    expect(attachment['visibility']).toBe('private');
    expect(attachment['url']).toBe(`/media/${id}/content`);

    const content = await app.inject({
      method: 'GET',
      url: `/media/${id}/content`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toContain('image/png');
    expect(content.headers['content-disposition']).toContain('inline');
    expect(content.rawPayload.equals(png(3000, 1500))).toBe(true);
  });

  it('generates real image variants that are fetchable by name', async () => {
    const { id, res } = await upload(ownerToken, await realPng(3000, 1500), '?filename=big.png');
    expect(res.statusCode).toBe(201);
    const attachment = (
      res.json() as { attachment: { variants: Array<{ name: string; format: string }> } }
    ).attachment;
    const names = attachment.variants.map((v) => v.name);
    expect(names).toEqual(['thumb', 'medium', 'large']);
    expect(attachment.variants.every((v) => v.format === 'webp')).toBe(true);

    const thumb = await app.inject({
      method: 'GET',
      url: `/media/${id}/content?variant=thumb`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toContain('image/webp');
    const meta = await sharp(thumb.rawPayload).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(256);

    const missing = await app.inject({
      method: 'GET',
      url: `/media/${id}/content?variant=nope`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects a body whose real type is not allowed even when labelled as an image', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/media',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from('<html><body>not an image</body></html>'),
    });
    expect(res.statusCode).toBe(415);
    expect((res.json() as { code: string }).code).toBe('media.unsupported_type');
  });

  it('marks an attachment public and serves it anonymously', async () => {
    const { id } = await upload(ownerToken, png(8, 8), '?visibility=public');
    const anon = await app.inject({ method: 'GET', url: `/media/${id}/content` });
    expect(anon.statusCode).toBe(200);
    expect(anon.headers['cache-control']).toContain('public');

    const meta = await app.inject({ method: 'GET', url: `/media/${id}` });
    expect(meta.statusCode).toBe(200);
  });

  it('hides a private attachment from other users', async () => {
    const { id } = await upload(ownerToken, png(8, 8));
    const other = await app.inject({
      method: 'GET',
      url: `/media/${id}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(other.statusCode).toBe(403);

    const otherContent = await app.inject({
      method: 'GET',
      url: `/media/${id}/content`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(otherContent.statusCode).toBe(403);

    const anon = await app.inject({ method: 'GET', url: `/media/${id}/content` });
    expect(anon.statusCode).toBe(403);
  });

  it('lists only the caller own attachments, with admin cross-owner access', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/media',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(mine.statusCode).toBe(200);
    const items = (mine.json() as { attachments: Array<{ ownerId: string }> }).attachments;
    expect(items.length).toBeGreaterThan(0);

    const ownerId = items[0]?.ownerId ?? '';
    const forbidden = await app.inject({
      method: 'GET',
      url: `/media?ownerId=${ownerId}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const asAdmin = await app.inject({
      method: 'GET',
      url: `/media?ownerId=${ownerId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(asAdmin.statusCode).toBe(200);
  });

  it('renames an attachment for the owner and forbids others', async () => {
    const { id } = await upload(ownerToken, png(8, 8));
    const denied = await app.inject({
      method: 'PATCH',
      url: `/media/${id}`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { filename: 'hacked.png' },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'PATCH',
      url: `/media/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { filename: 'renamed.png', visibility: 'public' },
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { attachment: { filename: string } }).attachment.filename).toBe(
      'renamed.png',
    );
  });

  it('forces active content (SVG) to download instead of rendering inline', async () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const { id } = await upload(ownerToken, svg, '?filename=evil.svg&visibility=public');
    const res = await app.inject({ method: 'GET', url: `/media/${id}/content` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    // Never inline: an SVG can carry script and the app CSP allows unsafe-inline.
    expect(String(res.headers['content-disposition'])).toContain('attachment');
  });

  it('deletes an attachment, audits it, then 404s', async () => {
    const { id } = await upload(ownerToken, png(8, 8));
    const prisma = getPrisma();

    const removed = await app.inject({
      method: 'DELETE',
      url: `/media/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(removed.statusCode).toBe(200);

    const gone = await app.inject({
      method: 'GET',
      url: `/media/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(gone.statusCode).toBe(404);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'media.delete', resourceId: id },
    });
    expect(audit).toBeTruthy();
  });
});
