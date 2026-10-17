import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PluginError } from '@stackpanel/sdk';
import type { McpCapability } from '@stackpanel/sdk';
import type { FastifyRequest } from 'fastify';
import { getPrisma } from '../plugins/prisma.ts';
import { currentUser } from '../plugins/auth.ts';
import { encryptSecret, decryptSecret, isSecretsEnabled } from '../lib/crypto.ts';
import { agentHttp, rpcResult } from './http.ts';

export const serverIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
export const toolSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  description: z.string().max(4000).default(''),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object' }),
  readOnly: z.boolean().default(false),
  destructive: z.boolean().default(true),
}).strict();
export const serverSchema = z.object({
  name: z.string().trim().min(1).max(120), url: z.string().url().max(2048),
  enabled: z.boolean().default(false), tools: z.array(toolSchema).max(100).default([]),
}).strict();
export const externalScope = (id: string): string => `mcp.external.${id}`;
const secretKey = (actorId: string, id: string): string => `agent.mcp.${id}.${actorId}`;
export const externalTools = (value: unknown) => z.array(toolSchema).parse(value);

export function mayUseExternal(request: FastifyRequest, id: string): boolean {
  const user = currentUser(request); const scope = externalScope(id);
  return user.viaApiToken ? (user.effectiveScopes ?? []).includes(scope) : user.permissions.has(scope);
}

/** Ordinary capabilities: discovered once, executed through the same guarded HTTP endpoint. */
export async function externalCapabilities(request: FastifyRequest): Promise<McpCapability[]> {
  const servers = await getPrisma().agentMcpServer.findMany({ where: { enabled: true }, orderBy: { id: 'asc' }, take: 100 });
  return servers.filter((server) => mayUseExternal(request, server.id)).flatMap((server) => externalTools(server.tools).map((tool) => ({
    id: `ext.${server.id}.v${server.revision}.${tool.name}`, method: 'POST' as const,
    path: `/api/v1/agent/external/${server.id}/v${server.revision}/tools/${encodeURIComponent(tool.name)}`,
    scope: externalScope(server.id), summary: `${server.name}: ${tool.description || tool.name}。body 参数格式：${JSON.stringify(tool.inputSchema)}`,
    mutating: !tool.readOnly, destructive: !tool.readOnly && tool.destructive,
  })));
}

export async function saveExternalCredential(actorId: string, id: string, token: string): Promise<void> {
  if (!isSecretsEnabled()) throw new PluginError('secret.storage.disabled', 501, '未配置加密密钥存储');
  await getPrisma().secret.upsert({ where: { key: secretKey(actorId, id) }, create: { key: secretKey(actorId, id), ciphertext: encryptSecret(token) }, update: { ciphertext: encryptSecret(token) } });
}
export async function removeExternalCredential(actorId: string, id: string): Promise<void> {
  await getPrisma().secret.deleteMany({ where: { key: secretKey(actorId, id) } });
}
export async function hasExternalCredential(actorId: string, id: string): Promise<boolean> {
  return Boolean(await getPrisma().secret.findUnique({ where: { key: secretKey(actorId, id) }, select: { key: true } }));
}

/** A fresh short-lived MCP session per operation; credentials never pass to the model. */
export async function externalRpc(actorId: string, serverId: string, method: string, params: unknown, signal?: AbortSignal, revision?: number): Promise<unknown> {
  const db = getPrisma();
  const server = await db.agentMcpServer.findUnique({ where: { id: serverId } });
  if (revision !== undefined && server?.revision !== revision) throw new PluginError('agent.mcp_revision_changed', 409, '工具配置已变化，请重新确认');
  if (!server?.enabled) throw new PluginError('agent.mcp_unavailable', 409, '外部服务未启用');
  const secret = await db.secret.findUnique({ where: { key: secretKey(actorId, serverId) } });
  const headers: Record<string, string> = { 'mcp-protocol-version': '2025-06-18' };
  if (secret) headers.authorization = `Bearer ${decryptSecret(secret.ciphertext)}`;
  const send = async (name: string, input: unknown, notification = false) => {
    const id = randomUUID();
    const res = await agentHttp(server.url, { jsonrpc: '2.0', ...(notification ? {} : { id }), method: name, params: input }, headers, signal);
    if (res.status < 200 || res.status >= 300) throw new PluginError('agent.mcp_remote', 502, '外部 MCP 拒绝请求，请核对凭证和服务状态');
    const session = res.headers['mcp-session-id'];
    if (typeof session === 'string') headers['mcp-session-id'] = session;
    return notification ? undefined : rpcResult(res.text, id);
  };
  await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stackpanel-agent', version: '1.0.0' } });
  await send('notifications/initialized', {}, true);
  return send(method, params);
}

/** Once an external write has started, an unknown outcome must not be blindly retried. */
export async function executeExternal(request: FastifyRequest, serverId: string, toolName: string, revision: number): Promise<unknown> {
  const db = getPrisma(); const user = currentUser(request);
  if (!mayUseExternal(request, serverId)) throw new PluginError('agent.mcp_forbidden', 403, '没有此外部服务的权限');
  const server = await db.agentMcpServer.findUnique({ where: { id: serverId } });
  const tool = server?.enabled ? externalTools(server.tools).find((item) => item.name === toolName) : null;
  if (!tool) throw new PluginError('agent.mcp_tool_missing', 404, '工具不存在或未审核启用');
  if (server?.revision !== revision) throw new PluginError('agent.mcp_revision_changed', 409, '工具配置已变化，请重新发起任务并确认');
  const args = request.body ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new PluginError('validation.invalid', 422, '工具参数必须是对象');
  const validate = request.compileValidationSchema(tool.inputSchema);
  if (!validate(args)) throw new PluginError('validation.invalid', 422, '工具参数不符合审核后的 schema');
  if (tool.readOnly) return externalRpc(user.id, serverId, 'tools/call', { name: toolName, arguments: args }, undefined, revision);
  if (user.viaApiToken && !user.tokenScopes?.includes('mcp.write')) throw new PluginError('agent.mcp_write_required', 403, '凭证未授予 MCP 写入权限');
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) throw new PluginError('request.idempotency_key_required', 400, '写操作需要 Idempotency-Key');
  const id = createHash('sha256').update(`mcp:${user.id}:${serverId}:${toolName}:${key}`).digest('hex');
  const hash = createHash('sha256').update(JSON.stringify({ revision: server?.revision, args })).digest('hex');
  const existing = await db.agentOperation.findUnique({ where: { id } });
  if (existing) {
    if (existing.requestHash !== hash) throw new PluginError('agent.idempotency_conflict', 409, '工具或参数已变化，请重新确认');
    if (existing.status === 'DONE') return existing.result;
    throw new PluginError('agent.operation_unknown', 409, '操作已发出但结果尚未确认，请到外部服务核对，禁止自动重复执行');
  }
  try { await db.agentOperation.create({ data: { id, actorId: user.id, kind: 'mcp', requestHash: hash } }); }
  catch (error) { if ((error as {code?: string}).code === 'P2002') throw new PluginError('agent.operation_busy', 409, '该操作正在执行或等待核对'); throw error; }
  const result = await externalRpc(user.id, serverId, 'tools/call', { name: toolName, arguments: args }, undefined, revision);
  await db.agentOperation.update({ where: { id }, data: { status: 'DONE', result: result as object } });
  return result;
}
