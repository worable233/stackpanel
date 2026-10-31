import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readCaptchaCspSources, resetCaptchaCspCache } from '@/lib/captcha-csp';

/**
 * Captcha CSP sources (spec §5.1).
 *
 * The proxy runs on every page request, so this reader must be cheap, must cache
 * successes, and must never throw: a missing or broken captcha provider may
 * degrade the widget, never the site. A failure is cached only briefly — the
 * proxy derives `worker-src` from this answer, so a failure held for the full
 * success window would block a proof-of-work widget for that whole window.
 */

function mockFetch(handler: () => Promise<Response> | Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(handler())),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetCaptchaCspCache();
});

describe('readCaptchaCspSources', () => {
  it('returns the declared origins', async () => {
    mockFetch(() =>
      json({
        sources: {
          script: ['https://challenges.example.test'],
          style: ['https://challenges.example.test'],
          frame: ['https://challenges.example.test'],
          connect: ['https://api.example.test'],
          worker: ['https://challenges.example.test'],
        },
      }),
    );
    await expect(readCaptchaCspSources()).resolves.toEqual({
      script: ['https://challenges.example.test'],
      style: ['https://challenges.example.test'],
      frame: ['https://challenges.example.test'],
      connect: ['https://api.example.test'],
      worker: [],
    });
  });

  it('drops anything that is not an absolute https origin', async () => {
    mockFetch(() =>
      json({
        sources: {
          // A buggy or hostile provider must not be able to widen the policy.
          script: ['javascript:alert(1)', 'data:text/javascript,1', 'http://plain.test'],
          frame: ['https://ok.test/path?x=1', 'not a url'],
          connect: [],
        },
      }),
    );
    const sources = await readCaptchaCspSources();
    expect(sources.script).toEqual([]);
    // Normalized to an origin: path and query cannot smuggle extra directives.
    expect(sources.frame).toEqual(['https://ok.test']);
  });

  it('relays the blob: worker scheme a proof-of-work widget needs', async () => {
    mockFetch(() => json({ sources: { worker: ['blob:'] } }));
    await expect(readCaptchaCspSources()).resolves.toEqual({
      script: [],
      style: [],
      frame: [],
      connect: [],
      worker: ['blob:'],
    });
  });

  it('drops data: even though it would also parse as a scheme source', async () => {
    mockFetch(() => json({ sources: { worker: ['data:text/javascript,1', 'blob:'] } }));
    const sources = await readCaptchaCspSources();
    expect(sources.worker).toEqual(['blob:']);
  });

  it('returns empty sources when no provider is installed', async () => {
    mockFetch(() => json({ configured: false, sources: {} }));
    await expect(readCaptchaCspSources()).resolves.toEqual({
      script: [],
      style: [],
      frame: [],
      connect: [],
      worker: [],
    });
  });

  it('never throws when the kernel is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    await expect(readCaptchaCspSources()).resolves.toEqual({
      script: [],
      style: [],
      frame: [],
      connect: [],
      worker: [],
    });
  });

  it('caches the result, including a failed read', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(json({ sources: { connect: ['https://a.test'] } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await readCaptchaCspSources();
    await readCaptchaCspSources();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a failed read long before the success TTL expires', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(json({ error: 'down' }, 503))
        .mockResolvedValue(json({ sources: { worker: ['blob:'] } }));
      vi.stubGlobal('fetch', fetchMock);

      const first = await readCaptchaCspSources();
      expect(first.worker).toEqual([]);

      // A burst of requests collapses onto the cached failure ...
      await readCaptchaCspSources();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // ... but recovery is seconds away, not the full success window: an API
      // restart must not leave every page without `worker-src`.
      vi.setSystemTime(Date.now() + 3_000);
      const third = await readCaptchaCspSources();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(third.worker).toEqual(['blob:']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json({ sources: {} })));
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([readCaptchaCspSources(), readCaptchaCspSources()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
