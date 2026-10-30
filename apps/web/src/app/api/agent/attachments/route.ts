import type { NextRequest } from 'next/server';
import { getSessionToken, getSessionUser } from '@/lib/auth';
import { isSameOriginRequest } from '@/lib/request-origin';
export const dynamic = 'force-dynamic';
const limit = 5 * 1024 * 1024;
const types = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  const token = await getSessionToken();
  if (!user || !token) return Response.json({ code: 'agentRoute.unauthenticated' }, { status: 401 });
  if (!isSameOriginRequest(request)) return Response.json({ code: 'agentRoute.badOrigin' }, { status: 403 });
  const type = request.headers.get('content-type') ?? '';
  if (!types.includes(type)) return Response.json({ code: 'agentRoute.unsupportedImage' }, { status: 422 });
  if (Number(request.headers.get('content-length')) > limit) return Response.json({ code: 'agentRoute.imageTooLarge' }, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ code: 'agentRoute.missingImage' }, { status: 422 });
  try {
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); return Response.json({ code: 'agentRoute.imageTooLarge' }, { status: 413 }); }
      chunks.push(value);
    }
    if (!length) return Response.json({ code: 'agentRoute.missingImage' }, { status: 422 });
    const body = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    const filename = new URL(request.url).searchParams.get('filename')?.slice(0, 191) || 'image';
    const base = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
    const response = await fetch(`${base}/media?visibility=private&filename=${encodeURIComponent(filename)}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body,
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(60000),
    });
    const data = await response.json();
    if (!response.ok) return Response.json(data, { status: response.status });
    const file = data.attachment;
    if (!types.includes(file.mime)) return Response.json({ code: 'agentRoute.invalidImage' }, { status: 422 });
    return Response.json({ attachment: { id: file.id, name: file.filename, url: `/api/agent/attachments/${file.id}` } }, { status: 201 });
  } catch { return Response.json({ code: 'agentRoute.uploadFailed' }, { status: 502 }); }
}
