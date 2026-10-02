import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@stackpanel/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { PLATFORM_INFO_SETTING_KEY } from '../../src/lib/platform-info.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

describe.skipIf(!dbAvailable)('platform information integration (real DB)', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  const adminEmail = `platform_admin_${suffix}@example.com`;
  const userEmail = `platform_user_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';
  let adminId = '';
  let previous: unknown = undefined;
  let hadPrevious = false;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    const existing = await prisma.setting.findUnique({ where: { key: PLATFORM_INFO_SETTING_KEY } });
    hadPrevious = existing !== null;
    previous = existing?.value;
    const admin = await createAdminUser(app, adminEmail, password);
    const user = await createTestUser(app, userEmail, password);
    adminToken = admin.token;
    userToken = user.token;
    adminId = admin.userId;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    if (hadPrevious) {
      await prisma.setting.upsert({
        where: { key: PLATFORM_INFO_SETTING_KEY },
        create: { key: PLATFORM_INFO_SETTING_KEY, value: previous as Prisma.InputJsonValue },
        update: { value: previous as Prisma.InputJsonValue },
      });
    } else {
      await prisma.setting.deleteMany({ where: { key: PLATFORM_INFO_SETTING_KEY } });
    }
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('exposes defaults publicly and restricts updates to administrators', async () => {
    const publicRead = await app.inject({ method: 'GET', url: '/platform/info' });
    expect(publicRead.statusCode).toBe(200);
    expect((publicRead.json() as { platform: { name: string } }).platform.name).toBeTruthy();

    const anonymous = await app.inject({
      method: 'PATCH',
      url: '/admin/platform/info',
      payload: { name: 'Example', description: 'Example platform', url: null },
    });
    expect(anonymous.statusCode).toBe(401);

    const user = await app.inject({
      method: 'PATCH',
      url: '/admin/platform/info',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { name: 'Example', description: 'Example platform', url: null },
    });
    expect(user.statusCode).toBe(403);
  });

  it('validates, persists, audits, and protects the reserved setting key', async () => {
    const invalid = await app.inject({
      method: 'PATCH',
      url: '/admin/platform/info',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Example', description: 'Example platform', url: 'ftp://example.com' },
    });
    expect(invalid.statusCode).toBe(400);

    const saved = await app.inject({
      method: 'PATCH',
      url: '/admin/platform/info',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Example Panel',
        description: 'A validated platform identity.',
        url: 'https://example.com',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as { platform: { name: string } }).platform.name).toBe('Example Panel');

    const publicRead = await app.inject({ method: 'GET', url: '/platform/info' });
    expect((publicRead.json() as { platform: { url: string | null } }).platform.url).toBe(
      'https://example.com',
    );

    const bypass = await app.inject({
      method: 'PUT',
      url: `/admin/settings/${PLATFORM_INFO_SETTING_KEY}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { value: { name: 'Bypass' } },
    });
    expect(bypass.statusCode).toBe(403);

    const audit = await getPrisma().auditLog.findFirst({
      where: { action: 'platform.info.update' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.actorId).toBe(adminId);
  });
});
