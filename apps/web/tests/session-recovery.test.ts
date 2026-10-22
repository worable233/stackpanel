import { describe, expect, it } from 'vitest';
import { ApiError } from '@stackpanel/sdk';
import { expiredSessionLoginPath, isExpiredSessionError } from '@/lib/session-recovery';

describe('expired session recovery', () => {
  it('recognises only kernel unauthenticated responses as an expired session', () => {
    expect(
      isExpiredSessionError(
        new ApiError('unauthenticated', { status: 401, code: 'auth.unauthenticated' }),
      ),
    ).toBe(true);
    expect(
      isExpiredSessionError(
        new ApiError('upstream credentials rejected', {
          status: 401,
          code: 'zjmf.client.credentials_rejected',
        }),
      ),
    ).toBe(false);
    expect(isExpiredSessionError(new ApiError('unknown upstream 401', { status: 401 }))).toBe(false);
    expect(isExpiredSessionError(new ApiError('forbidden', { status: 403 }))).toBe(false);
    expect(isExpiredSessionError(new Error('unauthenticated'))).toBe(false);
  });

  it('preserves a safe return path and rejects external destinations', () => {
    expect(expiredSessionLoginPath('/admin/plugin/zjmf-upstream/connections')).toBe(
      '/login?next=%2Fadmin%2Fplugin%2Fzjmf-upstream%2Fconnections',
    );
    expect(expiredSessionLoginPath('https://example.com')).toBe('/login?next=%2Fadmin');
  });
});
