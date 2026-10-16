import { parseAgent } from './validation.ts';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PluginError } from '@stackpanel/sdk';
import { getPrisma } from '../plugins/prisma.ts';
import { currentUser, requireAuth, requireRole, permissionsOf } from '../plugins/auth.ts';
import { generateApiToken } from '../lib/api-tokens.ts';
import { canGrantScope } from '../lib/capability-registry.ts';
import { writeAudit, auditContext } from '../plugins/audit.ts';
import { getStateService } from '../state/index.ts';
import { env } from '../config/env.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export function oauthOrigin(): string | null { return env.AGENT_PUBLIC_ORIGIN ? new URL(env.AGENT_PUBLIC_ORIGIN).origin : null; }
export function mcpChallenge(): string {
  const origin = oauthOrigin();
  return origin ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` : 'Bearer realm="StackPanel"';
}
const authorization = z.object({ client_id: z.string().min(1).max(191), redirect_uri: z.string().url(), response_type: z.literal('code'),
  scope: z.string().max(4000).default(''), state: z.string().min(16).max(512),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'), resource: z.string().url().optional() });
const redirectSchema = z.string().url().refine((text) => { const url = new URL(text); return !url.hash && !url.username && !url.password &&
  (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))); }, '回调地址必须为 HTTPS 或本机回环 HTTP');

export async function agentOAuthRoutes(app: FastifyInstance): Promise<void> {
  const db = getPrisma();
  const issuer = () => { const origin = oauthOrigin(); if (!origin || !env.AGENT_WEB_ORIGIN) throw new PluginError('agent.oauth_unconfigured', 503, '需配置 AGENT_PUBLIC_ORIGIN 与 AGENT_WEB_ORIGIN'); return origin; };
  const metadata = async () => { const origin = issuer(); return { issuer: origin, authorization_endpoint: `${new URL(env.AGENT_WEB_ORIGIN as string).origin}/account/agent/authorize`,
    token_endpoint: `${origin}/oauth/token`, revocation_endpoint: `${origin}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] }; };
  app.get('/.well-known/oauth-authorization-server', metadata);
  const resourceMetadata = async () => ({ resource: `${issuer()}/mcp`, authorization_servers: [issuer()], bearer_methods_supported: ['header'] });
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);
  app.get('/admin/agent/oauth-clients', { preHandler: [requireAuth, requireRole('ADMIN')] }, async () => ({ clients: await db.agentOAuthClient.findMany({ orderBy: { createdAt: 'desc' } }) }));
  app.put('/admin/agent/oauth-clients/:id', { preHandler: [requireAuth, requireRole('ADMIN')] }, async (request) => {
    if (currentUser(request).impersonatorId) throw new PluginError('agent.impersonation_forbidden', 403, '冒用会话不能管理授权客户端');
    const id = parseAgent(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }), request.params).id;
    const value = parseAgent(z.object({ name: z.string().min(1).max(120), redirectUris: z.array(redirectSchema).min(1).max(20), enabled: z.boolean().default(true) }).strict(), request.body);
    const client = await db.agentOAuthClient.upsert({ where: { id }, create: { id, ...value }, update: value });
    if (!value.enabled) {
      const issued = await db.agentOAuthGrant.findMany({ where: { clientId: id, tokenId: { not: null } }, select: { tokenId: true } });
      await db.apiToken.updateMany({ where: { id: { in: issued.flatMap((row) => row.tokenId ? [row.tokenId] : []) } }, data: { status: 'REVOKED' } });
      await db.agentOAuthGrant.updateMany({ where: { clientId: id }, data: { consumedAt: new Date() } });
    }
    await writeAudit({ action: 'agent.oauth.client.update', resource: 'oauth.client', resourceId: id, ...auditContext(request) });
    return { client };
  });
  const inspect = async (raw: unknown, userId: string) => {
    const value = parseAgent(authorization, raw); const client = await db.agentOAuthClient.findUnique({ where: { id: value.client_id } });
    if (!client?.enabled || !Array.isArray(client.redirectUris) || !client.redirectUris.includes(value.redirect_uri)) throw new PluginError('oauth.invalid_client', 400, '客户端或回调地址无效');
    if (value.resource && value.resource !== `${issuer()}/mcp`) throw new PluginError('oauth.invalid_target', 400, '授权资源无效');
    const scopes = [...new Set(value.scope.split(/\s+/).filter(Boolean))];
    const owned = await permissionsOf(userId);
    if (scopes.some((scope) => scope !== 'mcp.write' && !canGrantScope(scope, owned, app.pluginRuntime.scopeGovernance()))) throw new PluginError('oauth.invalid_scope', 403, '请求包含当前用户不能授予的权限');
    return { value, client, scopes };
  };
  app.get('/api/v1/agent/oauth/authorize', { preHandler: requireAuth }, async (request) => {
    const { client, scopes, value } = await inspect(request.query, currentUser(request).id);
    return { client: { id: client.id, name: client.name }, scopes, redirectUri: value.redirect_uri };
  });
  app.post('/api/v1/agent/oauth/authorize', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    if (user.viaApiToken || user.impersonatorId) throw new PluginError('oauth.human_consent_required', 403, '授权必须由本人登录会话确认');
    const { value, client, scopes } = await inspect(request.body, user.id);
    const code = secret();
    await db.agentOAuthGrant.create({ data: { hash: hash(code), familyId: hash(code), kind: 'code', clientId: client.id, userId: user.id,
      scopes, redirectUri: value.redirect_uri, challenge: value.code_challenge, expiresAt: new Date(Date.now() + 120_000) } });
    await writeAudit({ action: 'agent.oauth.consent', resource: 'oauth.client', resourceId: client.id, ...auditContext(request) });
    const redirect = new URL(value.redirect_uri); redirect.searchParams.set('code', code); redirect.searchParams.set('state', value.state);
    return { redirectUri: redirect.href };
  });
  // OAuth clients post application/x-www-form-urlencoded; parser is scoped to these routes.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => { done(null, Object.fromEntries(new URLSearchParams(String(body)))); });
  app.post('/oauth/token', async (request, reply) => {
    issuer();
    reply.header('cache-control', 'no-store');
    const rpm = await getStateService().incr(`agent:oauth:${request.ip}:${Math.floor(Date.now() / 60_000)}`, 65_000);
    if (rpm > 60) return reply.code(429).send({ error: 'temporarily_unavailable' });
    const input = z.object({ grant_type: z.enum(['authorization_code', 'refresh_token']), client_id: z.string().min(1).max(191),
      code: z.string().max(1024).optional(), refresh_token: z.string().max(1024).optional(), redirect_uri: z.string().optional(),
      code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).optional(), resource: z.string().optional() }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    const value = input.data;
    const grant = await db.agentOAuthGrant.findUnique({ where: { hash: hash((value.grant_type === 'authorization_code' ? value.code : value.refresh_token) ?? '') } });
    const client = await db.agentOAuthClient.findUnique({ where: { id: value.client_id } });
    // Refresh replay revokes every access and refresh credential in this family.
    if (client?.enabled && grant?.clientId === client.id && grant.kind === 'refresh' && grant.consumedAt) {
      await revokeOAuthFamily(grant.familyId);
    }
    const expected = value.code_verifier ? createHash('sha256').update(value.code_verifier).digest('base64url') : '';
    if (!client?.enabled || !grant || grant.consumedAt || grant.expiresAt <= new Date() || grant.clientId !== client.id ||
      grant.kind !== (value.grant_type === 'authorization_code' ? 'code' : 'refresh') ||
      (grant.kind === 'code' && (grant.redirectUri !== value.redirect_uri || !Array.isArray(client.redirectUris) || !client.redirectUris.includes(value.redirect_uri ?? '') || grant.challenge !== expected)) ||
      (value.resource && value.resource !== `${issuer()}/mcp`)) return reply.code(400).send({ error: 'invalid_grant' });
    const user = await db.user.findUnique({ where: { id: grant.userId } });
    if (!user || user.status !== 'ACTIVE') return reply.code(400).send({ error: 'invalid_grant' });
    const owned = await permissionsOf(user.id);
    const scopes = (grant.scopes as string[]).filter((scope) => scope === 'mcp.write' || canGrantScope(scope, owned, app.pluginRuntime.scopeGovernance()));
    const access = generateApiToken(), refresh = secret();
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${grant.familyId}))`;
        const currentClient = await tx.agentOAuthClient.findUnique({where:{id:client.id}});
        if (!currentClient?.enabled) throw new Error('disabled');
        const claim = await tx.agentOAuthGrant.updateMany({ where: { hash: grant.hash, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
        if (!claim.count) throw new Error('consumed');
        if (grant.tokenId) {
          const old = await tx.apiToken.findUnique({ where: { id: grant.tokenId } });
          if (!old || old.status !== 'ACTIVE') throw new Error('revoked');
          await tx.apiToken.update({ where: { id: grant.tokenId }, data: { status: 'REVOKED' } });
        }
        const token = await tx.apiToken.create({ data: { userId: user.id, audience: 'mcp', name: `OAuth: ${client.name}`, scopes, keyHash: access.keyHash, keyPrefix: access.keyPrefix, expiresAt: new Date(Date.now() + 3600_000) } });
        await tx.agentOAuthGrant.create({ data: { hash: hash(refresh), familyId: grant.familyId, kind: 'refresh', clientId: client.id, userId: user.id, scopes, tokenId: token.id, expiresAt: new Date(Date.now() + 30 * 86400_000) } });
      });
    } catch {
      if (grant.kind === 'refresh' && (await db.agentOAuthGrant.findUnique({where:{hash:grant.hash}}))?.consumedAt) await revokeOAuthFamily(grant.familyId);
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    return { access_token: access.plaintext, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: scopes.join(' ') };
  });
  app.post('/oauth/revoke', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const input = z.object({ client_id: z.string(), token: z.string().max(8192) }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
    const grant = await db.agentOAuthGrant.findUnique({ where: { hash: hash(input.data.token) } });
    if (grant?.clientId === input.data.client_id) {
      await revokeOAuthFamily(grant.familyId);
    } else {
      // Access-token revocation must prove the issued token belongs to this client.
      const access = await db.apiToken.findUnique({ where: { keyHash: hash(input.data.token) } });
      const owner = access ? await db.agentOAuthGrant.findFirst({ where: { tokenId: access.id, clientId: input.data.client_id } }) : null;
      if (owner && access) await revokeOAuthFamily(owner.familyId);
    }
    return reply.code(200).send();
  });
}

async function revokeOAuthFamily(familyId: string): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${familyId}))`;
    const grants = await tx.agentOAuthGrant.findMany({where:{familyId},select:{tokenId:true}});
    await tx.apiToken.updateMany({where:{id:{in:grants.flatMap((row)=>row.tokenId?[row.tokenId]:[])}},data:{status:'REVOKED'}});
    await tx.agentOAuthGrant.updateMany({where:{familyId},data:{consumedAt:new Date()}});
  });
}
