import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * 菜单树可编辑（对标 #12.3），真实 DB + HTTP。
 *
 * 每个用例都从干净状态开始：菜单覆写是全局单例配置，测试之间互相污染的话，
 * 「默认顺序」这种断言会随执行顺序飘。
 */
describe.skipIf(!dbAvailable)('admin nav editing (real DB)', () => {
  let app: FastifyInstance;
  const adminEmail = `nav_edit_admin_${Date.now()}@example.com`;
  const userEmail = `nav_edit_user_${Date.now()}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';
  const userIds: string[] = [];

  const asAdmin = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
    const options: InjectOptions = {
      method,
      url,
      headers: { authorization: `Bearer ${adminToken}` },
    };
    if (payload !== undefined) options.payload = payload as NonNullable<InjectOptions['payload']>;
    return app.inject(options);
  };

  const adminNav = async () => {
    const response = await asAdmin('GET', '/admin/nav?surface=admin');
    expect(response.statusCode).toBe(200);
    return response.json() as {
      surface: string;
      items: Array<{
        href: string;
        label: string;
        hidden: boolean;
        custom: boolean;
        overrideId: string | null;
        defaultLabel: string | null;
      }>;
    };
  };

  const publicNav = async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/nav/admin',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { items: Array<{ href: string; label: string }> };
  };

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    // 登录/注册来自 login 插件，不走内核自带路由。
    await app.pluginRuntime.activate('login');
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    userIds.push(admin.userId, user.userId);
    adminToken = admin.token;
    userToken = user.token;
  });

  beforeEach(async () => {
    await getPrisma().navEntry.deleteMany({});
    await getPrisma().auditLog.deleteMany({
      where: { action: { in: ['nav.layout.save', 'nav.entry.create', 'nav.entry.delete'] } },
    });
  });

  afterAll(async () => {
    await getPrisma().navEntry.deleteMany({});
    if (userIds.length > 0) {
      await getPrisma().user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app.close();
  });

  it('returns kernel defaults in their documented order', async () => {
    const { items } = await adminNav();
    expect(items[0]).toMatchObject({ href: '/admin', label: '工作台', custom: false });
    expect(items.map((item) => item.href)).toContain('/admin/users');
    expect(items.some((item) => item.hidden)).toBe(false);
  });

  it('reorders, renames and hides, and the public menu reflects exactly that', async () => {
    const before = await adminNav();
    const reordered = [
      { href: '/admin/audit', label: '操作记录' },
      ...before.items
        .filter((item) => item.href !== '/admin/audit')
        .map((item) => ({ href: item.href, label: item.label, hidden: item.href === '/admin/users' })),
    ];
    const save = await asAdmin('PUT', '/admin/nav/admin', { items: reordered });
    expect(save.statusCode).toBe(200);

    const after = await adminNav();
    expect(after.items[0]).toMatchObject({ href: '/admin/audit', label: '操作记录' });
    // 隐藏项在后台仍然可见（否则就再也改不回来了）。
    expect(after.items.find((item) => item.href === '/admin/users')?.hidden).toBe(true);

    const live = await publicNav();
    expect(live.items[0]).toMatchObject({ href: '/admin/audit', label: '操作记录' });
    expect(live.items.some((item) => item.href === '/admin/users')).toBe(false);
    // 对外契约只有三个字段。
    expect(Object.keys(live.items[0] ?? {}).sort()).toEqual(['href', 'label', 'surface']);
  });

  it('adds custom links at the end and rejects unsafe hrefs', async () => {
    const created = await asAdmin('POST', '/admin/nav/admin/items', {
      label: '帮助文档',
      href: 'https://docs.example.com/stackpanel',
    });
    expect(created.statusCode).toBe(200);

    const live = await publicNav();
    expect(live.items.at(-1)).toMatchObject({
      href: 'https://docs.example.com/stackpanel',
      label: '帮助文档',
    });

    const duplicate = await asAdmin('POST', '/admin/nav/admin/items', {
      label: '重复',
      href: 'https://docs.example.com/stackpanel',
    });
    expect(duplicate.statusCode).toBe(409);

    // 协议相对地址看起来像站内路径，实际是外链，不能放过。
    for (const href of ['//evil.example.com', 'javascript:alert(1)', 'ftp://example.com']) {
      const bad = await asAdmin('POST', '/admin/nav/admin/items', { label: 'x', href });
      expect(bad.statusCode, href).toBe(400);
    }
  });

  it('rejects duplicate and unknown hrefs in a saved layout', async () => {
    const duplicate = await asAdmin('PUT', '/admin/nav/admin', {
      items: [
        { href: '/admin', label: '工作台' },
        { href: '/admin', label: '工作台 2' },
      ],
    });
    expect(duplicate.statusCode).toBe(400);

    const unknown = await asAdmin('PUT', '/admin/nav/admin', {
      items: [{ href: '/admin/not-a-real-page', label: '假的' }],
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('deleting a custom link removes it, deleting an override restores the default', async () => {
    // 用站外链接当自定义项：/admin/seo 这类站内路径已经是默认菜单项了。
    const external = 'https://docs.example.com/guide';
    const created = await asAdmin('POST', '/admin/nav/admin/items', { label: '指南', href: external });
    expect(created.statusCode).toBe(200);
    await asAdmin('PUT', '/admin/nav/admin', {
      items: [
        { href: '/admin', label: '控制台' },
        ...(await adminNav()).items
          .filter((item) => item.href !== '/admin' && item.href !== external)
          .map((item) => ({ href: item.href, label: item.label })),
        { href: external, label: '指南' },
      ],
    });

    const withOverrides = await adminNav();
    const customRow = withOverrides.items.find((item) => item.href === external);
    expect(customRow?.custom).toBe(true);
    expect(customRow?.overrideId).toBeTruthy();

    const removeCustom = await asAdmin('DELETE', `/admin/nav/items/${customRow?.overrideId}`);
    expect(removeCustom.statusCode).toBe(200);
    expect((await adminNav()).items.some((item) => item.href === external)).toBe(false);

    const firstRow = (await adminNav()).items.find((item) => item.href === '/admin');
    expect(firstRow).toMatchObject({ label: '控制台', overrideId: expect.any(String) });
    const revert = await asAdmin('DELETE', `/admin/nav/items/${firstRow?.overrideId}`);
    expect(revert.statusCode).toBe(200);
    expect((await adminNav()).items.find((item) => item.href === '/admin')).toMatchObject({
      label: '工作台',
      overrideId: null,
    });
  });

  it('hiding a menu entry does not change who can reach the page', async () => {
    // 这是本条最容易退化的地方：把「隐藏」当成「禁用」。
    await asAdmin('PUT', '/admin/nav/admin', {
      items: (await adminNav()).items.map((item) => ({
        href: item.href,
        label: item.label,
        hidden: item.href === '/admin/users',
      })),
    });
    expect((await publicNav()).items.some((item) => item.href === '/admin/users')).toBe(false);

    const asUser = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(asUser.statusCode).toBe(403);

    const asAdminUser = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(asAdminUser.statusCode).toBe(200);
  });

  it('is admin-only and audits every write', async () => {
    const unauth = await app.inject({ method: 'GET', url: '/admin/nav?surface=admin' });
    expect(unauth.statusCode).toBe(401);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/admin/nav?surface=admin',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    await asAdmin('POST', '/admin/nav/admin/items', { label: '帮助', href: 'https://docs.example.com' });
    await asAdmin('PUT', '/admin/nav/admin', {
      items: (await adminNav()).items.map((item) => ({ href: item.href, label: item.label })),
    });
    const actions = await getPrisma().auditLog.findMany({
      where: { action: { in: ['nav.layout.save', 'nav.entry.create', 'nav.entry.delete'] } },
      select: { action: true },
    });
    expect(actions.map((row) => row.action).sort()).toEqual([
      'nav.entry.create',
      'nav.layout.save',
    ]);
  });
});
