/**
 * Avatar HTTP surface (kernel-owned, media-backed).
 *
 * The contract under test: an avatar is an ordinary media attachment that the
 * account points at, so it inherits the media domain's sniffing, WebP encode,
 * variant ladder, public-visibility delivery and `attachment_references` in-use
 * guard — while the account payload carries a *derived* URL that changes when the
 * bytes change (so no cache can keep serving the previous face).
 */
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

/** A real, decodable PNG so the sharp pipeline can actually encode it. */
async function realPng(width: number, height: number, rgb: [number, number, number]) {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
  return Buffer.from(buf);
}

const AVATAR_URL = /^\/media\/(att_[A-Za-z0-9]+)\/content\?(variant=thumb&)?v=([0-9a-f]{16})$/;

describe.skipIf(!dbAvailable)('avatar HTTP surface (real DB + local storage)', () => {
  let app: FastifyInstance;
  let dataDir = '';
  const suffix = Date.now();
  const email = `avatar_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let token = '';
  let userId = '';
  let firstBig = Buffer.alloc(0);
  let secondBig = Buffer.alloc(0);

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-avatar-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const created = await createTestUser(app, email, password);
    token = created.token;
    userId = created.userId;
    // Large enough that the variant ladder produces a `thumb` rung.
    firstBig = await realPng(900, 900, [200, 40, 40]);
    secondBig = await realPng(700, 700, [40, 120, 220]);
  });

  afterAll(async () => {
    await getPrisma().user.deleteMany({ where: { email } });
    await getPrisma().attachment.deleteMany({ where: { ownerId: userId } });
    await app?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const upload = (payload: Buffer, contentType = 'image/png') =>
    app.inject({
      method: 'POST',
      url: '/auth/avatar',
      headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
      payload,
    });

  it('stores an avatar, exposes it on the account payload and serves it publicly', async () => {
    const res = await upload(firstBig);
    expect(res.statusCode).toBe(201);
    const { avatarUrl } = res.json() as { avatarUrl: string };
    expect(avatarUrl).toMatch(AVATAR_URL);
    const attachmentId = AVATAR_URL.exec(avatarUrl)?.[1] ?? '';

    // The account payload is derived from the same pointer, not a stored string.
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    const payload = me.json() as { user: { avatarUrl: string | null } };
    expect(payload.user.avatarUrl).toBe(avatarUrl);

    // The bytes went through the media pipeline: converted to WebP, and readable
    // by anyone (an avatar is shown to other users, so it cannot need the owner's
    // session).
    const anonymous = await app.inject({ method: 'GET', url: avatarUrl });
    expect(anonymous.statusCode).toBe(200);
    expect(String(anonymous.headers['content-type'])).toContain('image/webp');
    expect(anonymous.body.length).toBeGreaterThan(0);

    const record = await getPrisma().attachment.findUnique({ where: { id: attachmentId } });
    expect(record?.visibility).toBe('public');
    expect(record?.ownerId).toBe(userId);
  });

  it('registers an in-use reference so the media console cannot orphan it', async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const attachmentId = AVATAR_URL.exec(
      (me.json() as { user: { avatarUrl: string | null } }).user.avatarUrl ?? '',
    )?.[1];
    expect(attachmentId).toBeTruthy();
    const references = await getPrisma().$queryRaw<Array<{ resourceType: string; field: string }>>`
      SELECT "resourceType", "field" FROM "attachment_references"
      WHERE "attachmentId" = ${attachmentId}
    `;
    expect(references).toEqual([{ resourceType: 'user', field: 'avatar' }]);
  });

  it('replaces the previous avatar and sweeps the old attachment', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    const oldUrl = (before.json() as { user: { avatarUrl: string | null } }).user.avatarUrl ?? '';
    const oldId = AVATAR_URL.exec(oldUrl)?.[1] ?? '';

    const res = await upload(secondBig);
    expect(res.statusCode).toBe(201);
    const newUrl = (res.json() as { avatarUrl: string }).avatarUrl;
    // A different picture is a different revision, so the URL moves — that is what
    // keeps caches from showing the previous face.
    expect(newUrl).not.toBe(oldUrl);
    expect(newUrl).toMatch(AVATAR_URL);

    // Exactly one avatar attachment survives, and the replaced bytes are gone.
    expect(await getPrisma().attachment.findUnique({ where: { id: oldId } })).toBeNull();
    const remaining = await getPrisma().attachment.count({ where: { ownerId: userId } });
    expect(remaining).toBe(1);
  });

  it('rejects non-images, SVG (active content), oversize bodies and anonymous calls', async () => {
    const text = await app.inject({
      method: 'POST',
      url: '/auth/avatar',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('not an image at all', 'utf8'),
    });
    expect(text.statusCode).toBe(415);

    const svg = await app.inject({
      method: 'POST',
      url: '/auth/avatar',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/svg+xml' },
      payload: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8'),
    });
    expect(svg.statusCode).toBe(415);

    // Valid PNG magic, padded past the avatar ceiling: sniffing succeeds, the
    // size guard is what must stop it.
    const oversize = Buffer.concat([firstBig, Buffer.alloc(5 * 1024 * 1024)]);
    expect((await upload(oversize)).statusCode).toBe(413);

    const anonymous = await app.inject({
      method: 'POST',
      url: '/auth/avatar',
      headers: { 'content-type': 'image/png' },
      payload: firstBig,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('surfaces the avatar on the admin user list and detail, without the pointer', async () => {
    const adminEmail = `avatar_admin_${suffix}@example.com`;
    const admin = await createAdminUser(app, adminEmail, password);
    try {
      const me = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      const accountUrl = (me.json() as { user: { avatarUrl: string | null } }).user.avatarUrl;
      expect(accountUrl).toBeTruthy();

      // One page of people must resolve every face without a per-row read; the
      // payload also keeps `avatarAttachmentId` internal — publishing the pointer
      // would invite clients to build their own media URLs and drop the revision.
      const list = await app.inject({
        method: 'GET',
        url: `/admin/users?page=1&pageSize=10&q=${encodeURIComponent(email)}`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(list.statusCode).toBe(200);
      const { users } = list.json() as {
        users: Array<{ email: string; avatarUrl?: string | null }>;
      };
      const row = users.find((user) => user.email === email);
      expect(row?.avatarUrl).toBe(accountUrl);
      expect(row && 'avatarAttachmentId' in row).toBe(false);

      const detail = await app.inject({
        method: 'GET',
        url: `/admin/users/${userId}`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(detail.statusCode).toBe(200);
      const detailUser = (
        detail.json() as { user: { avatarUrl: string | null } }
      ).user;
      expect(detailUser.avatarUrl).toBe(accountUrl);
      expect('avatarAttachmentId' in detailUser).toBe(false);
    } finally {
      await getPrisma().user.deleteMany({ where: { email: adminEmail } });
    }
  });

  it('clears the avatar, and clearing twice is a no-op', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/auth/avatar',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { avatarUrl: string | null }).avatarUrl).toBeNull();

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect((me.json() as { user: { avatarUrl: string | null } }).user.avatarUrl).toBeNull();
    expect(await getPrisma().attachment.count({ where: { ownerId: userId } })).toBe(0);

    const again = await app.inject({
      method: 'DELETE',
      url: '/auth/avatar',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.statusCode).toBe(200);
  });
});
