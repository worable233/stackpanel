import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Same-origin proxy for the public model-service snapshot.
 *
 * The browser must not need the kernel's internal URL, and the kernel route is
 * intentionally unauthenticated: it exposes only aggregate daily counts and
 * public model names, never users, prompts, revenue or credentials.
 */
export async function GET() {
  const base = (process.env.API_BASE_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/llm-gateway/stats`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      return NextResponse.json({ error: 'upstream_unavailable' }, { status: 502 });
    }
    return NextResponse.json(await response.json(), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'upstream_unavailable' }, { status: 502 });
  }
}
