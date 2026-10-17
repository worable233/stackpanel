import type { NextRequest } from 'next/server';
import { getSessionToken, getSessionUser } from '@/lib/auth';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(); const token = await getSessionToken();
  if (!user || !token) return new Response(null, { status: 401 });
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,191}$/.test(id)) return new Response(null, { status: 404 });
  const base = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
  const options = { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' as const, redirect: 'error' as const, signal: AbortSignal.timeout(30000) };
  try {
    const metadata = await fetch(`${base}/media/${id}`, options);
    if (!metadata.ok) return new Response(null, { status: metadata.status });
    const { attachment } = await metadata.json();
    if (attachment.ownerId !== user.sub || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.mime)) return new Response(null, { status: 404 });
    const response = await fetch(`${base}/media/${id}/content`, options);
    return new Response(response.body, { status: response.status, headers: {
      'content-type': attachment.mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
    } });
  } catch { return new Response(null, { status: 502 }); }
}
