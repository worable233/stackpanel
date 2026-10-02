import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'sp_session';
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';

/**
 * Next.js 16 proxy (replaces the legacy `middleware` convention).
 * First line of defense only — every Fastify endpoint validates auth itself.
 *
 * Sessions are server-side, so the proxy asks the kernel `/auth/session`
 * instead of decoding a JWT. `/admin` requires a valid session with the ADMIN
 * role (the backend always re-checks permissions):
 *   - no/invalid session -> redirect to /login
 *   - authenticated non-admin -> 403
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  try {
    const res = await fetch(`${API_BASE_URL}/auth/session`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => null)) as {
      user?: { role?: string } | null;
    } | null;
    const user = body?.user ?? null;
    if (!user) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
    if (user.role !== 'ADMIN') {
      return new NextResponse('Forbidden', { status: 403 });
    }
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(new URL('/login', request.url));
  }
}

export const config = {
  matcher: ['/admin/:path*'],
};
