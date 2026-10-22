import { parseAgent } from './validation.ts';
import type { Prisma } from '@stackpanel/db';
import type { FastifyInstance } from 'fastify';
import { isPublicHttpUrl, resolvePublicAddresses } from '@stackpanel/net-guard';
import { z } from 'zod';
import { PluginError } from '@stackpanel/sdk';
import { getPrisma } from '../plugins/prisma.ts';
import { requireAuth, requireRole, currentUser } from '../plugins/auth.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { enforceTokenQuota } from '../lib/open-api-guard.ts';
import { serverIdSchema, serverSchema, externalScope, externalRpc, executeExternal, mayUseExternal, saveExternalCredential, removeExternalCredential, hasExternalCredential } from './external.ts';

export async function externalAgentRoutes(app: FastifyInstance): Promise<void> {
  const db = getPrisma(); const admin = [requireAuth, requireRole('ADMIN')];
  const auth = [requireAuth, enforceTokenQuota];
  const idOf = (params: unknown): string => parseAgent(serverIdSchema, (params as {id:string}).id);
  const noImpersonation = (request: Parameters<typeof currentUser>[0]) => { if (currentUser(request).impersonatorId) throw new PluginError('agent.impersonation_forbidden', 403, '冒用会话不能修改 Agent 授权'); };
  app.get('/admin/agent/mcp-servers', { preHandler: admin }, async () => ({ servers: await db.agentMcpServer.findMany({ orderBy: { id: 'asc' } }) }));
  app.put('/admin/agent/mcp-servers/:id', { preHandler: admin }, async (request) => {
    noImpersonation(request); const id = idOf(request.params); const parsed = parseAgent(serverSchema, request.body);
    for (const tool of parsed.tools) {
      if (JSON.stringify(tool.inputSchema).includes('$ref')) throw new PluginError('validation.invalid', 422, '工具 schema 不允许外部引用');
      try { request.compileValidationSchema(tool.inputSchema); } catch { throw new PluginError('validation.invalid', 422, '工具 schema 无效'); }
    }
    const value = { ...parsed, tools: parsed.tools as unknown as Prisma.InputJsonArray };
    if (!isPublicHttpUrl(value.url) || !(await resolvePublicAddresses(new URL(value.url).hostname))) throw new PluginError('agent.network_forbidden', 422, '仅允许可解析的公网 HTTPS 服务');
    if (new Set(parsed.tools.map((tool) => tool.name)).size !== parsed.tools.length) throw new PluginError('validation.invalid', 422, '工具名不能重复');
    const server = await db.$transaction(async (tx) => {
      const permission = await tx.permission.upsert({ where: { key: externalScope(id) }, create: { key: externalScope(id), name: `外部 MCP：${value.name}` }, update: { name: `外部 MCP：${value.name}` } });
      // Installation administrator owns the permission; other grants use normal RBAC UI.
      const group = await tx.permissionGroup.findUnique({ where: { id: 'group_admin' } });
      if (group) await tx.groupPermission.upsert({ where: { groupId_permissionId: { groupId: group.id, permissionId: permission.id } }, create: { groupId: group.id, permissionId: permission.id }, update: {} });
      return tx.agentMcpServer.upsert({ where: { id }, create: { id, ...value }, update: { ...value, revision: { increment: 1 } } });
    });
    await writeAudit({ action: 'agent.mcp.configure', resource: 'agent.mcp', resourceId: id, ...auditContext(request) });
    return { server };
  });
  app.post('/admin/agent/mcp-servers/:id/discover', { preHandler: admin }, async (request) => {
    noImpersonation(request);
    return { result: await externalRpc(currentUser(request).id, idOf(request.params), 'tools/list', {}) };
  });
  app.get('/api/v1/agent/mcp-servers', { preHandler: auth }, async (request) => {
    const servers = await db.agentMcpServer.findMany({ where: { enabled: true }, orderBy: { id: 'asc' } });
    return { servers: await Promise.all(servers.filter((server) => mayUseExternal(request, server.id)).map(async (server) => ({ ...server, credentialConfigured: await hasExternalCredential(currentUser(request).id, server.id) }))) };
  });
  app.put('/api/v1/agent/mcp-servers/:id/credential', { preHandler: auth }, async (request) => {
    noImpersonation(request); const id = idOf(request.params);
    if (!mayUseExternal(request, id)) throw new PluginError('agent.mcp_forbidden', 403, '没有此外部服务的权限');
    const input = parseAgent(z.object({ token: z.string().trim().min(1).max(8192).regex(/^[^\r\n]+$/) }).strict(), request.body);
    await saveExternalCredential(currentUser(request).id, id, input.token);
    await writeAudit({ action: 'agent.mcp.credential.update', resource: 'agent.mcp', resourceId: id, ...auditContext(request) });
    return { configured: true };
  });
  app.delete('/api/v1/agent/mcp-servers/:id/credential', { preHandler: auth }, async (request) => {
    noImpersonation(request); const id = idOf(request.params);
    await removeExternalCredential(currentUser(request).id, id);
    await writeAudit({ action: 'agent.mcp.credential.clear', resource: 'agent.mcp', resourceId: id, ...auditContext(request) });
    return { configured: false };
  });
  app.post('/api/v1/agent/external/:serverId/v:revision/tools/:toolName', { preHandler: auth }, async (request) => {
    noImpersonation(request);
    const params = parseAgent(z.object({ serverId: serverIdSchema, revision: z.coerce.number().int().positive(), toolName: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/) }), request.params);
    const result = await executeExternal(request, params.serverId, params.toolName, params.revision);
    await writeAudit({ action: 'agent.mcp.call', resource: 'agent.mcp', resourceId: params.serverId, ...auditContext(request) });
    return result;
  });
}
