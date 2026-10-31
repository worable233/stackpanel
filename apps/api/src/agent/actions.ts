import type { Prisma } from '@stackpanel/db';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PluginError, type McpCapability } from '@stackpanel/sdk';
import { z } from 'zod';
import { getPrisma } from '../plugins/prisma.ts';
import { currentUser, requireAuth, requireRole } from '../plugins/auth.ts';
import { enforceTokenQuota } from '../lib/open-api-guard.ts';
import { auditContext, writeAudit } from '../plugins/audit.ts';
import { parseAgent } from './validation.ts';

export const actionSchema = z.object({
  name: z.string().min(1).max(120), enabled: z.boolean().default(false),
  // Images must be pre-pulled and digest-pinned; clients cannot supply commands/images.
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
  argv: z.array(z.string().min(1).max(1000)).min(1).max(30),
  timeoutSeconds: z.number().int().min(1).max(60).default(30),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object' }),
}).strict();
const actionId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const revision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const scope = (id: string) => `agent.action.${id}`;
const allowed = (request: FastifyRequest, id: string) => {
  const user = currentUser(request);
  return user.viaApiToken ? user.effectiveScopes?.includes(scope(id)) : user.permissions.has(scope(id));
};
async function actions() {
  return (await getPrisma().setting.findMany({ where: { key: { startsWith: 'agent.action.' } }, take: 100 })).map((row) => ({ id: row.key.slice('agent.action.'.length), config: actionSchema.parse(row.value), revision: revision(row.value) }));
}
export async function actionCapabilities(request: FastifyRequest): Promise<McpCapability[]> {
  return (await actions()).filter((row) => row.config.enabled && allowed(request, row.id)).map((row) => ({
    id: `action.${row.id}.${row.revision}`, scope: scope(row.id), method: 'POST',
    path: `/api/v1/agent/actions/${row.id}/${row.revision}/execute`,
    summary: `${row.config.name}；body 参数：${JSON.stringify(row.config.inputSchema)}`,
    mutating: true, destructive: true,
  }));
}

/**
 * Accumulates a byte stream into a string, decoding across chunk boundaries.
 *
 * Decoding each chunk with `chunk.toString()` corrupts any multi-byte character
 * that straddles a boundary — both halves become U+FFFD, so Chinese output from
 * a sandboxed action arrives in the run record as mojibake. A persistent
 * `StringDecoder` holds the incomplete tail until the next chunk completes it.
 * The budget is charged on raw bytes, not decoded length, so a chatty stream
 * cannot grow the record past the limit.
 */
export function createTextSink(limitBytes: number): {
  push(chunk: Buffer): boolean;
  finish(): string;
} {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let bytes = 0;
  return {
    /** Appends `chunk`; returns `false` once the byte budget is exceeded. */
    push(chunk: Buffer): boolean {
      bytes += chunk.length;
      if (bytes > limitBytes) return false;
      text += decoder.write(chunk);
      return true;
    },
    finish: () => text + decoder.end(),
  };
}

/** No shell, host mounts, socket, network or local image builds. Unknown outcomes never rerun. */
export async function runSandbox(config: z.infer<typeof actionSchema>, input: unknown): Promise<{ stdout: string; stderr: string }> {
  const name = `sp-agent-${randomUUID()}`;
  const args = ['run', '--name', name, '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=128m', '--memory-swap=128m', '--cpus=0.5',
    '--user=65534:65534', '--log-driver=none', '--tmpfs=/tmp:rw,noexec,nosuid,size=16m', '-i', config.image, ...config.argv];
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      const outSink = createTextSink(256 * 1024);
      const errSink = createTextSink(256 * 1024);
      let bytes = 0;
      const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new PluginError('agent.action_timeout', 504, '隔离动作已超时，结果请核对执行记录')); }, config.timeoutSeconds * 1000);
      const append = (chunk: Buffer, error: boolean) => {
        // The limit covers stdout and stderr together.
        if (bytes + chunk.length > 256 * 1024) { bytes += chunk.length; child.kill('SIGKILL'); reject(new PluginError('agent.action_output_large', 502, '动作输出超出限制')); return; }
        bytes += chunk.length;
        (error ? errSink : outSink).push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => append(chunk, false)); child.stderr.on('data', (chunk: Buffer) => append(chunk, true));
      child.once('error', () => { clearTimeout(deadline); reject(new PluginError('agent.sandbox_unavailable', 503, 'Docker 隔离运行时不可用')); });
      child.once('close', (code) => { clearTimeout(deadline); const stdout = outSink.finish(), stderr = errSink.finish(); if (code === 0) resolve({ stdout, stderr }); else reject(new PluginError('agent.action_failed', 502, '隔离动作未成功完成，请由管理员核对运行时和执行记录')); });
      child.stdin.on('error', () => undefined); child.stdin.end(JSON.stringify(input));
    });
  } finally {
    await new Promise<void>((resolve) => { const cleanup = spawn('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 5000 }); cleanup.once('error', () => resolve()); cleanup.once('close', () => resolve()); });
  }
}

export async function actionRoutes(app: FastifyInstance): Promise<void> {
  const db = getPrisma(); const admin = [requireAuth, requireRole('ADMIN')];
  app.get('/admin/agent/actions', { preHandler: admin }, async () => ({ actions: await actions() }));
  app.put('/admin/agent/actions/:id', { preHandler: admin }, async (request) => {
    if (currentUser(request).impersonatorId) throw new PluginError('agent.impersonation_forbidden', 403, '冒用会话不能修改隔离动作');
    const id = parseAgent(z.object({ id: actionId }), request.params).id;
    const config = parseAgent(actionSchema, request.body);
    if (JSON.stringify(config.inputSchema).includes('"$ref"')) throw new PluginError('validation.invalid', 422, '动作 schema 不允许引用');
    try { request.compileValidationSchema(config.inputSchema); } catch { throw new PluginError('validation.invalid', 422, '动作 schema 无效'); }
    await db.$transaction(async (tx) => {
      await tx.permission.upsert({ where: { key: scope(id) }, create: { key: scope(id), name: `隔离动作：${config.name}` }, update: { name: `隔离动作：${config.name}` } });
      await tx.setting.upsert({ where: { key: scope(id) }, create: { key: scope(id), value: config as Prisma.InputJsonObject }, update: { value: config as Prisma.InputJsonObject } });
    });
    await writeAudit({ action: 'agent.action.configure', resource: 'agent.action', resourceId: id, ...auditContext(request) });
    return { id, config, revision: revision(config) };
  });
  app.post('/api/v1/agent/actions/:id/:revision/execute', { preHandler: [requireAuth, enforceTokenQuota] }, async (request) => {
    const params = parseAgent(z.object({ id: actionId, revision: z.string().regex(/^[a-f0-9]{16}$/) }), request.params);
    const user = currentUser(request);
    if (user.impersonatorId || !allowed(request, params.id) || (user.viaApiToken && !user.tokenScopes?.includes('mcp.write'))) throw new PluginError('agent.action_forbidden', 403, '没有此隔离动作的执行权限');
    const row = (await actions()).find((item) => item.id === params.id && item.revision === params.revision && item.config.enabled);
    if (!row) throw new PluginError('agent.action_changed', 409, '动作未启用或配置已变化');
    if (!request.compileValidationSchema(row.config.inputSchema)(request.body ?? {})) throw new PluginError('validation.invalid', 422, '动作参数无效');
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 200) throw new PluginError('request.idempotency_key_required', 400, '必须提供 Idempotency-Key');
    const id = createHash('sha256').update(`action:${user.id}:${row.id}:${key}`).digest('hex');
    const requestHash = createHash('sha256').update(JSON.stringify([row.revision, request.body])).digest('hex');
    const existing = await db.agentOperation.findUnique({ where: { id } });
    if (existing?.requestHash === requestHash && existing.status === 'DONE') return existing.result;
    if (existing) throw new PluginError('agent.operation_unknown', 409, '动作已发出或参数变化，禁止重复执行，请核对');
    try { await db.agentOperation.create({ data: { id, actorId: user.id, requestHash, kind: 'action' } }); }
    catch (error) { if ((error as {code?:string}).code === 'P2002') throw new PluginError('agent.operation_busy', 409, '动作正在执行'); throw error; }
    const result = await runSandbox(row.config, request.body ?? {});
    await db.agentOperation.update({ where: { id }, data: { status: 'DONE', result } });
    await writeAudit({ action: 'agent.action.execute', resource: 'agent.action', resourceId: row.id, ...auditContext(request) });
    return result;
  });
}
