import { ApiError } from '@stackpanel/sdk';
import { safeInternalPath } from './safe-path';

/**
 * Only the kernel's explicit unauthenticated problem invalidates the Web cookie.
 * Plugin operations may surface a third-party 401 (for example, an upstream
 * credential rejection); its HTTP status alone says nothing about this session.
 */
export function isExpiredSessionError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 401 &&
    error.code === 'auth.unauthenticated'
  );
}

/** Preserve only an internal return path when sending an expired session to login. */
export function expiredSessionLoginPath(returnPath: string): string {
  const next = safeInternalPath(returnPath) ?? '/admin';
  return `/login?next=${encodeURIComponent(next)}`;
}
