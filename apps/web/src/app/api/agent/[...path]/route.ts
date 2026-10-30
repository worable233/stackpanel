import type { NextRequest } from 'next/server';
import { getSessionToken, getSessionUser } from '@/lib/auth';
import { agentProxyTarget } from '@/lib/agent-proxy-path';
import { isSameOriginRequest } from '@/lib/request-origin';
export const dynamic = 'force-dynamic';

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path;
  const target = agentProxyTarget(request.method, path);
  if (!target) return Response.json({ code: 'agentRoute.notFound' }, { status: 404 });
  const user = await getSessionUser(); const session = await getSessionToken();
  if (!user || !session) return Response.json({ code: 'agentRoute.unauthenticated' }, { status: 401 });
  if (path[0] === 'admin' && user.role !== 'ADMIN') return Response.json({ code: 'agentRoute.adminOnly' }, { status: 403 });
  if (request.method !== 'GET' && !isSameOriginRequest(request)) return Response.json({ code: 'agentRoute.badOrigin' }, { status: 403 });
  const base = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
  const key = request.headers.get('x-agent-key');
  try {
    if (key) {
      if (key.length > 8192 || /[\r\n]/.test(key)) return Response.json({ code: 'agentRoute.invalidKey' }, { status: 400 });
      const check = await fetch(`${base}/api/v1/agent/credential`, { headers: { authorization: `Bearer ${key}` }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!check.ok || (await check.json()).actorId !== user.sub) return Response.json({ code: 'agentRoute.foreignKey' }, { status: 403 });
    }
    if (request.headers.get('content-length') && Number(request.headers.get('content-length')) > 1024 * 1024) return Response.json({ code: 'agentRoute.payloadTooLarge' }, { status: 413 });
    const body = request.method === 'GET' ? undefined : await request.text();
    if (body && new TextEncoder().encode(body).length > 1024 * 1024) return Response.json({ code: 'agentRoute.payloadTooLarge' }, { status: 413 });
    const headers: Record<string, string> = { authorization: `Bearer ${key ?? session}`, ...(body ? { 'content-type': 'application/json' } : {}) };
    const idempotency = request.headers.get('idempotency-key'); if (idempotency) headers['idempotency-key'] = idempotency;
    // No automatic write retry: a timeout can mean the operation already completed.
    const response = await fetch(`${base}${target}${request.nextUrl.search}`, { method: request.method, headers, ...(body ? { body } : {}), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(120000) });
    return new Response([204, 205, 304].includes(response.status) ? null : await response.text(), { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch { return Response.json({ code: 'agentRoute.unconfirmed' }, { status: 502 }); }
}
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
