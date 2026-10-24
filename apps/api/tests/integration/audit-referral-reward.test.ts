import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser } from '../auth-helpers.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { env } from '../../src/config/env.ts';

const dbAvailable = await checkDbAvailable();

/**
 * Is the referral plugin installed in this data directory?
 *
 * `referral` is not a kernel built-in: its source lives in the separate
 * `stackpanel-plugins` repository, and only a deployed environment has it under
 * `<dataDir>/plugins/referral`. A CI runner does not. Without this probe the
 * suite activates a missing plugin, then fails on `relation
 * "ext_referral_code" does not exist` — an error that reads like a schema bug
 * when the real cause is "the plugin was never installed here".
 */
const referralInstalled = existsSync(
  path.join(
    env.STACKPANEL_DATA_DIR ?? path.join(process.cwd(), 'data'),
    'plugins',
    'referral',
    'manifest.json',
  ),
);

/**
 * Regression: user-created referral codes inherit the administrator-owned
 * platform reward and cannot set or update a per-code amount.
 */
describe.skipIf(!dbAvailable || !referralInstalled)('regression: referral reward ownership', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  const adminEmail = `audit_ref_admin_${suffix}@example.com`;
  const attackerEmail = `audit_ref_attacker_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let attackerToken = '';
  let attackerId = '';

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const admin = await createAdminUser(app, adminEmail, password);
    adminToken = admin.token;
    for (const id of ['store', 'referral']) {
      await getPrisma().plugin.deleteMany({ where: { id } });
      const enable = await app.inject({
        method: 'PATCH',
        url: `/admin/plugins/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { enabled: true },
      });
      expect(enable.statusCode).toBe(200);
    }
  });

  afterAll(async () => {
    const prisma = getPrisma();
    const emails = [adminEmail, attackerEmail];
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    await prisma.walletLedgerEntry.deleteMany({ where: { userId: { in: ids } } });
    await prisma.walletAccount.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ext_referral_code" WHERE "spec"->>'ownerId' = $1`,
      attackerId,
    );
    for (const id of ['store', 'referral']) {
      await prisma.plugin.deleteMany({ where: { id } });
    }
    await app.close();
  });

  it('rejects per-code reward writes and uses the platform reward', async () => {
    const config = await app.inject({
      method: 'POST',
      url: '/store/admin/referrals/config',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        enabled: true,
        trigger: 'register',
        rewardAmount: 1,
        inviteeRewardAmount: 0,
        freezeDays: 0,
        cookieDays: 30,
        maxInvitesPerUser: 0,
        sameIpLimit: 1,
        currency: 'CNY',
      },
    });
    expect(config.statusCode).toBe(200);

    const attacker = await app.inject({
      method: 'POST',
      url: '/register',
      payload: { email: attackerEmail, password },
    });
    expect(attacker.statusCode).toBe(201);
    attackerToken = (attacker.json() as { token: string }).token;
    attackerId = (attacker.json() as { user: { id: string } }).user.id;

    const rejectedCreate = await app.inject({
      method: 'POST',
      url: '/referral/codes',
      headers: { authorization: `Bearer ${attackerToken}` },
      payload: { label: 'audit', rewardAmount: 1_000_000 },
    });
    expect(rejectedCreate.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/referral/codes',
      headers: { authorization: `Bearer ${attackerToken}` },
      payload: { label: 'audit' },
    });
    expect(created.statusCode).toBe(200);
    const code = (created.json() as { code: { id: string; code: string; rewardAmount: number } })
      .code;
    expect(code.rewardAmount).toBe(1);

    const rejectedUpdate = await app.inject({
      method: 'PATCH',
      url: `/referral/codes/${code.id}`,
      headers: { authorization: `Bearer ${attackerToken}` },
      payload: { rewardAmount: 1_000_000 },
    });
    expect(rejectedUpdate.statusCode).toBe(400);
  });
});
