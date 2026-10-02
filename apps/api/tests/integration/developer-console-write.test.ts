import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';
import {
  bodyDigest,
  canonicalRequest,
  isValidEd25519PrivateKey,
  isValidEd25519PublicKey,
  signCanonical,
  verifyRequestSignature,
} from '../../src/reseller/signing.ts';

const dbAvailable = await checkDbAvailable();

/**
 * Developer console write endpoints (批次 3 / CONSOLE-WRITE): reseller
 * lifecycle — create (server-generated Ed25519 inbound key, private key returned
 * exactly once), update, key rotation and delete — all admin-only and audited.
 */
describe.skipIf(!dbAvailable)('developer console write (real DB)', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  let adminToken = '';
  let adminEmail = '';
  let userToken = '';
  let userEmail = '';
  const createdIds: string[] = [];

  const auth = () => ({ authorization: `Bearer ${adminToken}` });

  async function createReseller(payload: Record<string, unknown>): Promise<{
    statusCode: number;
    body: {
      reseller?: { id: string; keyId: string; publicKey: string; hasWebhookKey: boolean };
      inboundPrivateKey?: string;
      error?: string;
    };
  }> {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/developer/resellers',
      headers: auth(),
      payload,
    });
    const body = res.json() as {
      reseller?: { id: string; keyId: string; publicKey: string; hasWebhookKey: boolean };
      inboundPrivateKey?: string;
      error?: string;
    };
    if (body.reseller) createdIds.push(body.reseller.id);
    return { statusCode: res.statusCode, body };
  }

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    adminEmail = `cw-admin-${suffix}@example.com`;
    adminToken = (await createAdminUser(app, adminEmail, 'password1234')).token;
    userEmail = `cw-user-${suffix}@example.com`;
    userToken = (await createTestUser(app, userEmail, 'password1234')).token;
  });

  afterAll(async () => {
    const prisma = getPrisma();
    for (const id of createdIds) {
      await prisma.webhookDelivery.deleteMany({ where: { resellerId: id } });
      await prisma.reseller.deleteMany({ where: { id } });
      await prisma.auditLog.deleteMany({ where: { resourceId: id } });
    }
    if (adminEmail) await prisma.user.deleteMany({ where: { email: adminEmail } });
    if (userEmail) await prisma.user.deleteMany({ where: { email: userEmail } });
    await app.close();
  });

  it('rejects a non-admin caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/developer/resellers',
      headers: { authorization: `Bearer ${userToken}` },
      payload: { name: `nope-${suffix}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an invalid body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/developer/resellers',
      headers: auth(),
      payload: { name: '', scopes: ['nope'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a channel and returns a working inbound key once', async () => {
    const { statusCode, body } = await createReseller({
      name: `cw-reseller-${suffix}`,
      scopes: ['catalog:read', 'order:write'],
      rateLimitRpm: 90,
    });
    expect(statusCode).toBe(200);
    const reseller = body.reseller;
    const privateKey = body.inboundPrivateKey;
    expect(reseller).toBeDefined();
    expect(privateKey).toBeTruthy();
    expect(isValidEd25519PrivateKey(privateKey as string)).toBe(true);
    expect(isValidEd25519PublicKey(reseller?.publicKey as string)).toBe(true);
    expect(reseller?.hasWebhookKey).toBe(false);
    expect(reseller?.keyId.startsWith('sp_')).toBe(true);

    // The returned private key must actually verify against the stored public key.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const canonical = canonicalRequest({
      method: 'GET',
      path: '/sp/v1/catalog',
      timestamp,
      nonce: `cw-${suffix}`,
      bodyDigest: bodyDigest(''),
    });
    const signature = signCanonical(canonical, privateKey as string);
    expect(
      verifyRequestSignature(
        {
          method: 'GET',
          path: '/sp/v1/catalog',
          timestamp,
          nonce: `cw-${suffix}`,
          signature,
          now: Number(timestamp) * 1000,
        },
        reseller?.publicKey as string,
      ),
    ).toEqual({ ok: true });

    // The list projection never leaks the private key.
    const list = await app.inject({
      method: 'GET',
      url: '/admin/developer/resellers?pageSize=100',
      headers: auth(),
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(privateKey);
  });

  it('creates a channel with a webhook callback key and audits the change', async () => {
    const { body } = await createReseller({
      name: `cw-hook-${suffix}`,
      webhookUrl: 'https://partner.example.com/hook',
    });
    expect(body.reseller?.hasWebhookKey).toBe(true);

    const prisma = getPrisma();
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'developer.reseller.create', resourceId: body.reseller?.id as string },
    });
    expect(audit).not.toBeNull();
  });

  it('rejects an internal webhook callback URL (audit M-3)', async () => {
    for (const webhookUrl of [
      'http://127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal/',
      'http://10.0.0.5/hook',
    ]) {
      const { statusCode } = await createReseller({
        name: `cw-ssrf-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        webhookUrl,
      });
      expect(statusCode, webhookUrl).toBe(400);
    }
  });

  it('updates a channel, including clearing the callback URL', async () => {
    const { body } = await createReseller({
      name: `cw-update-${suffix}`,
      webhookUrl: 'https://partner.example.com/hook',
    });
    const id = body.reseller?.id as string;

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/developer/resellers/${id}`,
      headers: auth(),
      payload: {
        name: `cw-update-renamed-${suffix}`,
        status: 'DISABLED',
        scopes: ['service:read'],
        rateLimitRpm: 15,
        webhookUrl: null,
      },
    });
    expect(res.statusCode).toBe(200);
    const updated = (res.json() as { reseller: Record<string, unknown> }).reseller;
    expect(updated.name).toBe(`cw-update-renamed-${suffix}`);
    expect(updated.status).toBe('DISABLED');
    expect(updated.scopes).toEqual(['service:read']);
    expect(updated.rateLimitRpm).toBe(15);
    expect(updated.webhookUrl).toBeNull();

    const audit = await getPrisma().auditLog.findFirst({
      where: { action: 'developer.reseller.update', resourceId: id },
    });
    expect(audit).not.toBeNull();
  });

  it('rotates the inbound key pair and invalidates the old key', async () => {
    const { body } = await createReseller({ name: `cw-rotate-${suffix}` });
    const id = body.reseller?.id as string;
    const oldPublicKey = body.reseller?.publicKey as string;

    const res = await app.inject({
      method: 'POST',
      url: `/admin/developer/resellers/${id}/rotate-key`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const rotated = res.json() as {
      reseller: { publicKey: string };
      inboundPrivateKey: string;
    };
    expect(rotated.reseller.publicKey).not.toBe(oldPublicKey);
    expect(isValidEd25519PrivateKey(rotated.inboundPrivateKey)).toBe(true);

    const audit = await getPrisma().auditLog.findFirst({
      where: { action: 'developer.reseller.rotate-key', resourceId: id },
    });
    expect(audit).not.toBeNull();
  });

  it('deletes a channel and cascades its deliveries', async () => {
    const { body } = await createReseller({ name: `cw-delete-${suffix}` });
    const id = body.reseller?.id as string;
    const prisma = getPrisma();
    await prisma.webhookDelivery.create({
      data: {
        id: `wh_cw_${suffix}`,
        resellerId: id,
        event: 'order.paid',
        url: 'https://partner.example.com/hook',
        payload: {},
        maxAttempts: 3,
      },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/developer/resellers/${id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { deleted: boolean }).deleted).toBe(true);
    expect(await prisma.reseller.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.webhookDelivery.count({ where: { resellerId: id } })).toBe(0);

    const detail = await app.inject({
      method: 'GET',
      url: `/admin/developer/resellers/${id}`,
      headers: auth(),
    });
    expect(detail.statusCode).toBe(404);
  });

  it('404s write operations on an unknown channel', async () => {
    for (const [method, url] of [
      ['PATCH', '/admin/developer/resellers/does-not-exist'],
      ['POST', '/admin/developer/resellers/does-not-exist/rotate-key'],
      ['DELETE', '/admin/developer/resellers/does-not-exist'],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth(), payload: {} });
      expect(res.statusCode).toBe(404);
    }
  });
});
