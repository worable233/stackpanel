import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { ApiClient } from '@stackpanel/sdk';

export interface SessionUser {
  sub: string;
  role: 'ADMIN' | 'USER';
}

function cookieName(): string {
  return process.env.SESSION_COOKIE_NAME ?? 'sp_session';
}

function apiBaseUrl(): string {
  return process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
}

/** Read the opaque session token from the cookie if present. */
export async function getSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(cookieName())?.value ?? null;
}

/**
 * Resolve the current session user via the API, or null when anonymous.
 *
 * Sessions are server-side (ADR-0017 §4), so the web app no longer decodes a
 * JWT locally: it asks the kernel, which is the only authority on session
 * validity. Deduplicated per request with React `cache`.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const token = await getSessionToken();
  if (!token) return null;
  try {
    const result = await new ApiClient({ baseUrl: apiBaseUrl(), token }).getSession();
    return result.user ? { sub: result.user.id, role: result.user.role } : null;
  } catch {
    return null;
  }
});
