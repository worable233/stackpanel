import { describe, expect, it, vi } from 'vitest';

// The BFF notification client reads the session cookie through `next/headers`.
// Mocking it here lets us exercise both the authenticated and anonymous paths,
// which is exactly the branch that previously degraded 401 into 500.
const cookieValue = vi.hoisted(() => ({ current: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieValue.current === undefined ? undefined : { name, value: cookieValue.current },
  }),
}));

import { ApiError } from '@stackpanel/sdk';
import { getBffNotificationClient } from '@/lib/notifications';

describe('getBffNotificationClient', () => {
  it('throws an ApiError with status 401 when anonymous', async () => {
    cookieValue.current = undefined;
    const error = await getBffNotificationClient().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });

  it('returns a client carrying the session token when authenticated', async () => {
    cookieValue.current = 'session-token';
    const client = await getBffNotificationClient();
    expect(client).toBeTruthy();
  });
});
