import { getSessionToken } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function apiBaseUrl(): string {
  return process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
}

/**
 * BFF proxy for the kernel notification SSE stream.
 *
 * Next.js acts as a thin, buffering-free pipe: the session token stays
 * server-side, and the upstream `text/event-stream` body is forwarded chunk by
 * chunk so the bell updates in real time. An unauthenticated request returns
 * 401 rather than opening a doomed stream.
 */
export async function GET(request: Request): Promise<Response> {
  const token = await getSessionToken();
  if (!token) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const upstream = await fetch(`${apiBaseUrl()}/notifications/stream`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    // Forward the client abort so the kernel drops the subscriber promptly.
    signal: request.signal,
    cache: 'no-store',
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(JSON.stringify({ error: 'notification stream unavailable' }), {
      status: upstream.status === 401 ? 401 : 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
