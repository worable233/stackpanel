import 'server-only';
import { ApiClient, ApiError } from '@stackpanel/sdk';
import { getSessionToken } from './auth';

/**
 * Notification BFF client: reads the session cookie and proxies to the kernel
 * notification endpoints. Used by the top-bar bell (client polling) and the
 * inbox pages, keeping the session token server-side.
 *
 * Anonymous access throws an `ApiError` with `status: 401` (not a bare Error),
 * so every `catch` in the notification routes can map it to a real 401 instead
 * of falling through to the 500 default. A bare Error here is what previously
 * turned "not signed in" into a 500 on the bell poll.
 */
export async function getBffNotificationClient(): Promise<ApiClient> {
  const token = await getSessionToken();
  if (!token) {
    throw new ApiError('unauthorized', { status: 401, code: 'auth.unauthorized' });
  }
  return new ApiClient({ baseUrl: process.env.API_BASE_URL ?? 'http://127.0.0.1:3001', token });
}
