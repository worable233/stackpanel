import type { NextRequest } from 'next/server';
import { getSessionToken, getSessionUser } from '@/lib/auth';
import { isSameOriginRequest } from '@/lib/request-origin';

export const dynamic = 'force-dynamic';

/**
 * Same-origin hop for avatar uploads.
 *
 * The browser cannot call the API directly (it holds an opaque session token that
 * only the server side reads from the cookie), so this route forwards the bytes
 * to the kernel's `/auth/avatar`. The API then stores the picture as an ordinary
 * media attachment and answers with the revisioned delivery URL.
 *
 * Guarantees mirrored from the API, so a hostile caller is refused early and
 * cheaply: authentication, same-origin (CSRF), raster-only content types, and the
 * 5MB ceiling — the same number the API enforces, so the two can never disagree.
 */
const LIMIT = 5 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function apiBaseUrl(): string {
  return process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
}

function jsonError(code: string, status: number): Response {
  return Response.json({ code }, { status });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  const token = await getSessionToken();
  if (!user || !token) return jsonError('avatarRoute.unauthenticated', 401);
  if (!isSameOriginRequest(request)) {
    return jsonError('avatarRoute.badOrigin', 403);
  }
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (!TYPES.includes(type)) return jsonError('avatarRoute.unsupportedImage', 422);
  if (Number(request.headers.get('content-length')) > LIMIT) {
    return jsonError('avatarRoute.imageTooLarge', 413);
  }
  const reader = request.body?.getReader();
  if (!reader) return jsonError('avatarRoute.missingImage', 422);
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      // `content-length` can lie or be absent (chunked), so the stream is counted
      // too rather than trusted.
      if (length > LIMIT) {
        await reader.cancel();
        return jsonError('avatarRoute.imageTooLarge', 413);
      }
      chunks.push(value);
    }
    if (!length) return jsonError('avatarRoute.missingImage', 422);
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    const response = await fetch(`${apiBaseUrl()}/auth/avatar`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': type },
      body,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => ({}));
    return Response.json(data, { status: response.status });
  } catch {
    return jsonError('avatarRoute.uploadFailed', 502);
  }
}

export async function DELETE(request: NextRequest) {
  const user = await getSessionUser();
  const token = await getSessionToken();
  if (!user || !token) return jsonError('avatarRoute.unauthenticated', 401);
  if (!isSameOriginRequest(request)) {
    return jsonError('avatarRoute.badOrigin', 403);
  }
  try {
    const response = await fetch(`${apiBaseUrl()}/auth/avatar`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => ({}));
    return Response.json(data, { status: response.status });
  } catch {
    return jsonError('avatarRoute.uploadFailed', 502);
  }
}
