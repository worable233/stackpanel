import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_WRITE_SCOPE } from '@stackpanel/sdk';
import { buildApp } from '../../src/app.ts';
import { PLATFORM_INFO_SETTING_KEY } from '../../src/lib/platform-info.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createAdminUser, createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * MCP Streamable HTTP surface (PLAN-open-platform P2).
 *
 * Verifies that MCP is a pure adapter over the capability registry: tools are
 * derived from capabilities, a scoped token only sees what it can call, writes
 * require an explicit `mcp.write` grant, and every tool call runs through the
 * real /api/v1 guards (so it is indistinguishable from a direct API call).
 */
describe.skipIf(!dbAvailable)('MCP streamable HTTP (real DB)', () => {
  let app: FastifyInstance;
  const suffix = Date.now();
  const adminEmail = `mcp_admin_${suffix}@example.com`;
  const userEmail = `mcp_user_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let adminToken = '';
  let userToken = '';
  let productId = '';
  let previousPlatform: unknown = undefined;
  let hadPreviousPlatform = false;
  const tokenIds: string[] = [];

  async function createToken(sessionToken: string, scopes: string[]): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/me/api-tokens',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { name: `mcp-${suffix}`, scopes, ipAllowlist: [] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; apiToken: { id: string } };
    tokenIds.push(body.apiToken.id);
    return body.token;
  }

  function rpc(token: string, method: string, params?: unknown, id = 1) {
    return app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) },
    });
  }

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const prisma = getPrisma();
    adminToken = (await createAdminUser(app, adminEmail, password)).token;
    userToken = (await createTestUser(app, userEmail, password)).token;

    const existing = await prisma.setting.findUnique({ where: { key: PLATFORM_INFO_SETTING_KEY } });
    hadPreviousPlatform = existing !== null;
    previousPlatform = existing?.value;

    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    const enable = await app.inject({
      method: 'PATCH',
      url: '/admin/plugins/store',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
    productId = `mcp_prod_${suffix}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ext_store_product"
         ("id", "owner_id", "version", "spec", "status", "labels", "annotations", "finalizers",
          "created_at", "updated_at", "f_status", "f_stock", "f_categoryId", "f_providerId")
       VALUES ($1, NULL, 1, $2::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
               now(), now(), 'ACTIVE', 3, NULL, NULL)`,
      productId,
      JSON.stringify({
        name: `mcp-product-${suffix}`,
        description: null,
        price: 1000,
        currency: 'CNY',
        cost: null,
        originalPrice: null,
        discount: null,
        stock: 3,
        status: 'ACTIVE',
        metadata: null,
        categoryId: null,
        fulfillmentType: 'instant',
        providerId: null,
        providerProductId: null,
      }),
    );
  });

  afterAll(async () => {
    const prisma = getPrisma();
    if (tokenIds.length > 0) {
      await prisma.apiTokenUsage.deleteMany({ where: { apiTokenId: { in: tokenIds } } });
      await prisma.apiToken.deleteMany({ where: { id: { in: tokenIds } } });
    }
    await prisma.$executeRawUnsafe(`DELETE FROM "ext_store_product" WHERE "id" = $1`, productId);
    await prisma.plugin.deleteMany({ where: { id: 'store' } });
    if (hadPreviousPlatform) {
      await prisma.setting.upsert({
        where: { key: PLATFORM_INFO_SETTING_KEY },
        create: { key: PLATFORM_INFO_SETTING_KEY, value: previousPlatform as never },
        update: { value: previousPlatform as never },
      });
    } else {
      await prisma.setting.deleteMany({ where: { key: PLATFORM_INFO_SETTING_KEY } });
    }
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });
    await app.close();
  });

  it('rejects an unauthenticated MCP request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('initializes with the protocol version and server identity', async () => {
    const token = await createToken(userToken, []);
    const res = await rpc(token, 'initialize');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.serverInfo.name).toBe('stackpanel');
  });

  it('derives tools from the capability registry', async () => {
    const token = await createToken(userToken, []);
    const res = await rpc(token, 'tools/list');
    const tools = (res.json() as { result: { tools: Array<{ name: string; capabilityId: string }> } })
      .result.tools;
    const ids = tools.map((tool) => tool.capabilityId);
    expect(ids).toContain('store.products.list');
    expect(ids).toContain('identity.read');
  });

  it('executes a read tool through the real /api/v1 handler', async () => {
    const token = await createToken(userToken, []);
    const res = await rpc(token, 'tools/call', {
      name: 'store_products_list',
      arguments: {},
    });
    expect(res.statusCode).toBe(200);
    const result = (
      res.json() as {
        result: { isError?: boolean; structuredContent?: { products: Array<{ id: string }> } };
      }
    ).result;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.products.some((p) => p.id === productId)).toBe(true);
  });

  it('hides mutating tools from a token without mcp.write', async () => {
    const token = await createToken(adminToken, ['platform.admin']);
    const res = await rpc(token, 'tools/list');
    const ids = (res.json() as { result: { tools: Array<{ capabilityId: string }> } }).result.tools.map(
      (tool) => tool.capabilityId,
    );
    // Read capabilities carry through even though the token holds the scope,
    // but the mutating `platform.info.write` must not be visible.
    expect(ids).toContain('platform.info.read');
    expect(ids).not.toContain('platform.info.write');
  });

  it('exposes mutating tools once the token declares mcp.write', async () => {
    const token = await createToken(adminToken, ['platform.admin', MCP_WRITE_SCOPE]);
    const res = await rpc(token, 'tools/list');
    const ids = (res.json() as { result: { tools: Array<{ capabilityId: string }> } }).result.tools.map(
      (tool) => tool.capabilityId,
    );
    expect(ids).toContain('platform.info.write');
  });

  it('requires an idempotencyKey to invoke a write tool, then replays safely', async () => {
    const token = await createToken(adminToken, ['platform.admin', MCP_WRITE_SCOPE]);
    const withoutKey = await rpc(token, 'tools/call', {
      name: 'platform_info_write',
      arguments: { body: { name: `mcp-${suffix}`, description: 'via mcp', url: null } },
    });
    const blocked = (withoutKey.json() as { result: { isError: boolean } }).result;
    expect(blocked.isError).toBe(true);

    const call = {
      name: 'platform_info_write',
      arguments: {
        idempotencyKey: `mcp-idem-${suffix}`,
        body: { name: `mcp-${suffix}`, description: 'via mcp', url: null },
      },
    };
    const first = await rpc(token, 'tools/call', call);
    expect((first.json() as { result: { isError?: boolean } }).result.isError).toBeFalsy();
    const replay = await rpc(token, 'tools/call', call);
    expect((replay.json() as { result: { isError?: boolean } }).result.isError).toBeFalsy();
  });

  it('acknowledges a notification with 202 and no body', async () => {
    const token = await createToken(userToken, []);
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });

  it('advertises the mcp.write scope as grantable', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/api-tokens/scopes',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const keys = (res.json() as { scopes: Array<{ key: string }> }).scopes.map((scope) => scope.key);
    expect(keys).toContain(MCP_WRITE_SCOPE);
  });

  it('records MCP calls against the token usage audit', async () => {
    const token = await createToken(userToken, []);
    await rpc(token, 'tools/call', { name: 'identity_read', arguments: {} });
    const prisma = getPrisma();
    const tokens = await prisma.apiToken.findMany({
      where: { userId: { not: '' }, name: `mcp-${suffix}` },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    const tokenId = tokens[0]?.id;
    expect(tokenId).toBeTruthy();
    let rows: Array<{ path: string }> = [];
    for (let attempt = 0; attempt < 20 && rows.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      rows = await prisma.apiTokenUsage.findMany({ where: { apiTokenId: tokenId ?? '' } });
    }
    // The tool call re-enters /api/v1/me, which is audited as an open-API call.
    expect(rows.some((row) => row.path === '/api/v1/me')).toBe(true);
  });
});
