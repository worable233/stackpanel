/**
 * 品牌图标上传的 HTTP 契约（logo / favicon）。
 *
 * 覆盖的是一次真实故障：管理员上传标准 `.ico` favicon，得到 415「仅支持图片文件」。
 * 三层都需要成立，缺一层用户就看不到图标：
 *
 *  1. 上传被接受（扩展名白名单含 `.ico`）；
 *  2. 字节以 `image/x-icon` 落库（否则 S3/CDN 回 `application/octet-stream`，
 *     部分浏览器拒绝渲染）；
 *  3. 读取时 `Content-Type` 与写入时一致（原来非 SVG/PNG 一律当 `image/webp`）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { clearBrandFile, readBrandFiles } from '../../src/lib/platform-brand.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/** reserved=0, type=1, count=1, then one 16×16 32bpp entry. */
const ICO = Buffer.from(
  '000001000100101000000100200068040000160000002800000010000000200000000100' +
    '2000000000000000000000000000000000000000000000000000000000000000',
  'hex',
);

function multipart(
  field: 'logo' | 'favicon',
  fileBuffer: Buffer,
  filename: string,
): { payload: Buffer; boundary: string } {
  const boundary = '----stackpanel-brand-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      'Content-Type: image/x-icon\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, fileBuffer, tail]), boundary };
}

describe.skipIf(!dbAvailable)('platform brand HTTP surface (real DB)', () => {
  let app: FastifyInstance;
  let dataDir = '';
  const suffix = Date.now();
  const email = `brand_admin_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-testdata-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const admin = await createAdminUser(app, email, password);
    adminToken = admin.token;
    const user = await createTestUser(app, `brand_user_${suffix}@example.com`, password);
    userToken = user.token;
  });

  afterAll(async () => {
    await clearBrandFile('logo').catch(() => undefined);
    await clearBrandFile('favicon').catch(() => undefined);
    await app.close();
    await getPrisma().$disconnect().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('accepts a .ico favicon and serves it back as image/x-icon', async () => {
    const { payload, boundary } = multipart('favicon', ICO, 'favicon.ico');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/platform/brand',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode, res.body).toBe(200);

    // The bytes really landed, with an ICO content type (write path).
    const stored = await readBrandFiles();
    expect(stored.favicon?.length).toBe(ICO.length);

    // ...and the read path agrees. Previously this answered `image/webp`.
    const served = await app.inject({ method: 'GET', url: '/platform/brand/favicon' });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toContain('image/x-icon');
    expect(Buffer.from(served.rawPayload).equals(ICO)).toBe(true);
  });

  it('writes to the field the browser actually sent, not the loop slot', async () => {
    // Regression: the upload loop used its own iterator as the destination, so
    // uploading only a favicon stored the bytes under `brand/logo` while
    // `brand/favicon` kept the default. The UI said 「已保存」 and nothing changed.
    await clearBrandFile('logo').catch(() => undefined);
    await clearBrandFile('favicon').catch(() => undefined);
    const before = await readBrandFiles();
    const logoBefore = before.logo;

    const { payload, boundary } = multipart('favicon', ICO, 'only-favicon.ico');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/platform/brand',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await readBrandFiles();
    expect(after.favicon?.length).toBe(ICO.length);
    // The logo must be untouched — not overwritten with the favicon's bytes.
    expect(after.logo?.equals(logoBefore ?? Buffer.alloc(0))).toBe(true);
  });

  it('rejects a real non-image with a stable code, not a vague prose-only body', async () => {
    const { payload, boundary } = multipart('logo', Buffer.from('not an image'), 'logo.bmp');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/platform/brand',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(415);
    const problem = res.json() as { code?: string; detail?: string };
    // The UI can only render a stable code; a bare `{ error }` collapsed to
    // `request.invalid` and lost the reason entirely.
    expect(problem.code).toBe('request.unsupported_media_type');
    expect(problem.detail).toContain('ico');
  });

  it('keeps the size ceiling on ico uploads', async () => {
    const huge = Buffer.alloc(1024 * 1024 + 1, 0);
    huge.write('00000100', 0, 'hex');
    const { payload, boundary } = multipart('logo', huge, 'big.ico');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/platform/brand',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(413);
  });

  it('stays admin-only', async () => {
    const { payload, boundary } = multipart('logo', ICO, 'logo.ico');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/platform/brand',
      headers: {
        authorization: `Bearer ${userToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(403);
  });
});
