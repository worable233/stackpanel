import type { FastifyInstance } from 'fastify';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createTestUser } from '../auth-helpers.ts';
import { bodyDigest, canonicalRequest, signCanonical } from '../sp-signing.ts';

const dbAvailable = await checkDbAvailable();

function generateEd25519KeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/**
 * 平台凭证请求签名（对标 #12.6）。
 *
 * 一个凭证要么「只凭 Bearer」，要么「Bearer + 每个请求的 Ed25519 签名」。没有中间态：
 * 登记了公钥却不要求签名，等于给客户一个「以为更安全」的错觉。
 *
 * 这些用例走真实 HTTP + 真实 DB，验的是四类拒绝（缺失/篡改/过期/重放）与两种
 * 兼容（未登记公钥的存量凭证、清除公钥后的回退）。
 */
describe.skipIf(!dbAvailable)('platform API token request signing (#12.6, real DB)', () => {
  let app: FastifyInstance;
  const keys = generateEd25519KeyPair();
  const otherKeys = generateEd25519KeyPair();
  let sessionToken = '';
  let userId = '';
  let signedToken = '';

  const sign = (
    method: string,
    path: string,
    options: { body?: string; timestamp?: number; nonce?: string; privateKey?: string } = {},
  ) => {
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const nonce = options.nonce ?? `n-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const body = options.body;
    const canonical = canonicalRequest({
      method,
      path,
      timestamp,
      nonce,
      bodyDigest: body === undefined ? bodyDigest(undefined) : bodyDigest(body),
    });
    return {
      'x-sp-timestamp': timestamp,
      'x-sp-nonce': nonce,
      'x-sp-signature': signCanonical(canonical, options.privateKey ?? keys.privateKey),
      'content-type': 'application/json',
    };
  };

  const call = async (input: {
    method: 'GET' | 'POST' | 'PATCH';
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }) =>
    app.inject({
      method: input.method,
      url: input.path,
      headers: input.headers ?? {},
      ...(input.body !== undefined ? { payload: input.body } : {}),
    });

  /** 只为断言状态码 + Problem code。 */
  const codeOf = (payload: string): string | undefined => {
    try {
      return (JSON.parse(payload) as { code?: string }).code;
    } catch {
      return undefined;
    }
  };

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    // /login and /register come from the login plugin; activate it before seeding users.
    await app.pluginRuntime.activate('login');
    const user = await createTestUser(app, `it_signing_${Date.now()}@example.com`, 'IntegrationPass123');
    sessionToken = user.token;
    userId = user.userId;

    const created = await app.inject({
      method: 'POST',
      url: '/me/api-tokens',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { name: 'signing-key', publicKey: keys.publicKey },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as {
      token: string;
      apiToken: { publicKey: string | null; signingEnabled: boolean };
    };
    expect(body.apiToken.signingEnabled).toBe(true);
    expect(body.apiToken.publicKey).toContain('BEGIN PUBLIC KEY');
    signedToken = body.token;
  });

  afterAll(async () => {
    await getPrisma().apiToken.deleteMany({ where: { userId } });
    if (userId) await getPrisma().user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  it('accepts a correctly signed request', async () => {
    const path = '/api/v1/me';
    const res = await call({
      method: 'GET',
      path,
      headers: { authorization: `Bearer ${signedToken}`, ...sign('GET', path) },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: { id: string } }).user.id).toBe(userId);
  });

  it('rejects an unsigned request when the token carries a public key', async () => {
    const res = await call({
      method: 'GET',
      path: '/api/v1/me',
      headers: { authorization: `Bearer ${signedToken}` },
    });
    expect(res.statusCode).toBe(401);
    expect(codeOf(res.payload)).toBe('request.signature_missing');
  });

  it('rejects a signature over a different body (tamper)', async () => {
    const path = '/api/v1/users';
    const sent = JSON.stringify({ email: 'tampered@example.com', name: 'x' });
    // 签的是另一份 body：改一个字节都必须失配。
    const headers = sign('POST', path, { body: JSON.stringify({ email: 'a@b.c' }) });
    const res = await call({
      method: 'POST',
      path,
      headers: { authorization: `Bearer ${signedToken}`, ...headers },
      body: sent,
    });
    expect(res.statusCode).toBe(401);
    expect(codeOf(res.payload)).toBe('request.signature_invalid');
  });

  it('rejects a signature from the wrong key', async () => {
    const path = '/api/v1/me';
    const res = await call({
      method: 'GET',
      path,
      headers: {
        authorization: `Bearer ${signedToken}`,
        ...sign('GET', path, { privateKey: otherKeys.privateKey }),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(codeOf(res.payload)).toBe('request.signature_invalid');
  });

  it('rejects a timestamp outside the window', async () => {
    const path = '/api/v1/me';
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const res = await call({
      method: 'GET',
      path,
      headers: { authorization: `Bearer ${signedToken}`, ...sign('GET', path, { timestamp: stale }) },
    });
    expect(res.statusCode).toBe(401);
    expect(codeOf(res.payload)).toBe('request.signature_expired');
  });

  it('rejects a replayed nonce even though the signature is valid', async () => {
    const path = '/api/v1/me';
    const headers = sign('GET', path, { nonce: 'fixed-nonce-for-replay' });
    const first = await call({
      method: 'GET',
      path,
      headers: { authorization: `Bearer ${signedToken}`, ...headers },
    });
    expect(first.statusCode).toBe(200);
    const second = await call({
      method: 'GET',
      path,
      headers: { authorization: `Bearer ${signedToken}`, ...headers },
    });
    expect(second.statusCode).toBe(401);
    expect(codeOf(second.payload)).toBe('request.signature_replayed');
  });

  it('refuses a non-Ed25519 public key at write time', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/api-tokens',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { name: 'bad-key', publicKey: 'not-a-pem-key' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps bearer-only tokens unsigned and lets disabling signing fall back', async () => {
    const plain = await app.inject({
      method: 'POST',
      url: '/me/api-tokens',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { name: 'bearer-only' },
    });
    expect(plain.statusCode).toBe(200);
    const plainToken = (plain.json() as { token: string }).token;
    const plainId = (plain.json() as { apiToken: { id: string } }).apiToken.id;

    // 未登记公钥：裸 Bearer 照旧可用（存量客户不中断）。
    const bearer = await call({
      method: 'GET',
      path: '/api/v1/me',
      headers: { authorization: `Bearer ${plainToken}` },
    });
    expect(bearer.statusCode).toBe(200);

    // 登记公钥 → 立刻要求签名。
    const enabled = await app.inject({
      method: 'PATCH',
      url: `/me/api-tokens/${plainId}`,
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { publicKey: keys.publicKey },
    });
    expect(enabled.statusCode).toBe(200);
    expect((enabled.json() as { apiToken: { signingEnabled: boolean } }).apiToken.signingEnabled).toBe(
      true,
    );
    const unsigned = await call({
      method: 'GET',
      path: '/api/v1/me',
      headers: { authorization: `Bearer ${plainToken}` },
    });
    expect(unsigned.statusCode).toBe(401);
    expect(codeOf(unsigned.payload)).toBe('request.signature_missing');

    // 清除公钥 → 回到 Bearer（这不是「悄悄放宽」，是凭证所有者的显式决定）。
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/me/api-tokens/${plainId}`,
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { publicKey: null },
    });
    expect(cleared.statusCode).toBe(200);
    const back = await call({
      method: 'GET',
      path: '/api/v1/me',
      headers: { authorization: `Bearer ${plainToken}` },
    });
    expect(back.statusCode).toBe(200);
  });
});
