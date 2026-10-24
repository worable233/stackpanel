import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXTENSION_POINTS, type SeoProvider } from '@stackpanel/sdk';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * 逐页 SEO 覆写（对标 #12.4）。
 *
 * 断言的是**分层语义**，不只是「能存能读」：
 * 覆写逐字段压在 provider 之上（provider 的 jsonLd 必须活着），noindex 要真的把
 * 页面从 sitemap 里拿掉，删掉覆写要能回到 provider 的原始输出。
 */
describe.skipIf(!dbAvailable)('per-page SEO overrides (#12.4, real DB)', () => {
  let app: FastifyInstance;
  let adminToken = '';
  let userToken = '';
  let adminEmail = '';
  let userEmail = '';
  let overrideId = '';

  const unregister: Array<() => void> = [];
  const provider: SeoProvider = {
    id: 'test-seo',
    listEntries: async () => ({
      entries: [{ url: '/about' }, { url: '/products/1' }],
      total: 2,
    }),
    resolveMeta: async ({ path }) =>
      path === '/about'
        ? { title: '关于（provider）', description: 'provider 描述', jsonLd: { '@type': 'AboutPage' } }
        : null,
  };

  const adminHeaders = () => ({ authorization: `Bearer ${adminToken}` });
  const userHeaders = () => ({ authorization: `Bearer ${userToken}` });

  const readMeta = async (path: string) => {
    const res = await app.inject({ method: 'GET', url: `/seo/meta?path=${encodeURIComponent(path)}` });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      meta: { title?: string; description?: string; noindex?: boolean; jsonLd?: unknown } | null;
      source: string | null;
    };
  };

  const sitemapUrls = async (): Promise<string[]> => {
    const res = await app.inject({ method: 'GET', url: '/seo/sitemap?pageSize=100' });
    expect(res.statusCode).toBe(200);
    return (res.json() as { entries: Array<{ url: string }> }).entries.map((entry) => entry.url);
  };

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const suffix = Date.now();
    adminEmail = `it_seo_admin_${suffix}@example.com`;
    userEmail = `it_seo_user_${suffix}@example.com`;
    adminToken = (await createAdminUser(app, adminEmail, 'IntegrationPass123')).token;
    userToken = (await createTestUser(app, userEmail, 'IntegrationPass123')).token;
    unregister.push(
      app.pluginRuntime.registerExtension(EXTENSION_POINTS.seoProvider, provider, 'test-seo'),
    );
  });

  afterAll(async () => {
    for (const off of unregister) off();
    const prisma = getPrisma();
    await prisma.seoPage.deleteMany({ where: { path: { in: ['/about'] } } });
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('serves the provider meta when no override exists', async () => {
    const result = await readMeta('/about');
    expect(result.source).toBe('test-seo');
    expect(result.meta?.title).toBe('关于（provider）');
    expect(result.meta?.jsonLd).toEqual({ '@type': 'AboutPage' });
  });

  it('is admin-only and rejects a path carrying a query string', async () => {
    const forbidden = await app.inject({
      method: 'PUT',
      url: '/admin/seo/pages',
      headers: userHeaders(),
      payload: { path: '/about', title: 'x' },
    });
    expect(forbidden.statusCode).toBe(403);

    const badPath = await app.inject({
      method: 'PUT',
      url: '/admin/seo/pages',
      headers: adminHeaders(),
      payload: { path: '/about?utm=1', title: 'x' },
    });
    expect(badPath.statusCode).toBe(400);

    const badImage = await app.inject({
      method: 'PUT',
      url: '/admin/seo/pages',
      headers: adminHeaders(),
      payload: { path: '/about', ogImage: 'javascript:alert(1)' },
    });
    expect(badImage.statusCode).toBe(400);
  });

  it('overrides field by field and keeps the provider jsonLd', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/admin/seo/pages',
      headers: adminHeaders(),
      payload: { path: '/about/', title: '关于我们', description: '平台介绍' },
    });
    expect(saved.statusCode).toBe(200);
    // 规范化：尾斜杠被收敛，同一页面只有一条覆写。
    expect((saved.json() as { page: { path: string } }).page.path).toBe('/about');
    overrideId = (saved.json() as { page: { id: string } }).page.id;

    const result = await readMeta('/about');
    expect(result.source).toBe('kernel');
    expect(result.meta?.title).toBe('关于我们');
    expect(result.meta?.description).toBe('平台介绍');
    expect(result.meta?.jsonLd).toEqual({ '@type': 'AboutPage' });

    const listed = await app.inject({
      method: 'GET',
      url: '/admin/seo/pages?query=about',
      headers: adminHeaders(),
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { total: number }).total).toBe(1);
  });

  it('drops a noindex page from the sitemap and puts it back on delete', async () => {
    expect(await sitemapUrls()).toEqual(['/about', '/products/1']);

    const saved = await app.inject({
      method: 'PUT',
      url: '/admin/seo/pages',
      headers: adminHeaders(),
      payload: { path: '/about', title: '关于我们', noindex: true },
    });
    expect(saved.statusCode).toBe(200);

    expect(await sitemapUrls()).toEqual(['/products/1']);
    expect((await readMeta('/about')).meta?.noindex).toBe(true);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/admin/seo/pages/${overrideId}`,
      headers: adminHeaders(),
    });
    expect(removed.statusCode).toBe(200);

    // 覆写消失后，页面回到 provider 的原始输出，sitemap 也恢复。
    const meta = await readMeta('/about');
    expect(meta.source).toBe('test-seo');
    expect(meta.meta?.title).toBe('关于（provider）');
    expect(meta.meta?.noindex).toBeUndefined();
    expect(await sitemapUrls()).toEqual(['/about', '/products/1']);
  });
});
