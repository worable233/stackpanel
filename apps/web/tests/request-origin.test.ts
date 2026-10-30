import { describe, expect, it } from 'vitest';
import { isSameOriginRequest } from '@/lib/request-origin';

/**
 * Regression: the same-origin guard compared `Origin` against
 * `request.nextUrl.origin`, which Next normalizes to the dev server's configured
 * host. Reaching the app as `127.0.0.1:3000` while it was configured as
 * `localhost:3000` therefore 403'd legitimate uploads (observed live on
 * `POST /api/account/avatar`), while a host match on the request itself works for
 * every alias the app is reachable under.
 */
function request(headers: Record<string, string | undefined>) {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) map.set(key.toLowerCase(), value);
  }
  return {
    headers: {
      get: (name: string) => map.get(name.toLowerCase()) ?? null,
    },
  };
}

describe('isSameOriginRequest', () => {
  it('accepts a same-host origin regardless of the host the server was started with', () => {
    expect(
      isSameOriginRequest(request({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' })),
    ).toBe(true);
    expect(
      isSameOriginRequest(request({ origin: 'http://localhost:3000', host: 'localhost:3000' })),
    ).toBe(true);
    expect(
      isSameOriginRequest(request({ origin: 'https://panel.example.com', host: 'panel.example.com' })),
    ).toBe(true);
  });

  it('rejects a different host (the cross-site CSRF case)', () => {
    expect(
      isSameOriginRequest(request({ origin: 'http://evil.example', host: '127.0.0.1:3000' })),
    ).toBe(false);
    expect(
      isSameOriginRequest(request({ origin: 'https://panel.example.com', host: 'panel.evil.example' })),
    ).toBe(false);
  });

  it('rejects a missing or malformed origin instead of falling open', () => {
    expect(isSameOriginRequest(request({ host: '127.0.0.1:3000' }))).toBe(false);
    expect(isSameOriginRequest(request({ origin: 'null', host: '127.0.0.1:3000' }))).toBe(false);
    expect(isSameOriginRequest(request({ origin: '/' }))).toBe(false);
  });

  it('honours the proxy-reported host and scheme when present', () => {
    expect(
      isSameOriginRequest(
        request({
          origin: 'https://panel.example.com',
          host: 'internal:3000',
          'x-forwarded-host': 'panel.example.com',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toBe(true);
    expect(
      isSameOriginRequest(
        request({
          // Right host, wrong scheme: reported by the proxy, so it must match.
          origin: 'http://panel.example.com',
          'x-forwarded-host': 'panel.example.com',
          'x-forwarded-proto': 'https',
        }),
      ),
    ).toBe(false);
  });

  it('uses the first entry of a comma-separated forwarded header chain', () => {
    expect(
      isSameOriginRequest(
        request({
          origin: 'https://panel.example.com',
          host: 'internal:3000',
          'x-forwarded-host': 'panel.example.com, edge.internal',
        }),
      ),
    ).toBe(true);
  });
});
