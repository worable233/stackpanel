import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readCaptchaCspSources, resetCaptchaCspCache } from '@/lib/captcha-csp';

/**
 * Captcha CSP sources (spec §5.1).
 *
 * The proxy runs on every page request, so this reader must be cheap, must cache
 * failures as well as successes, and must never throw: a missing or broken
 * captcha provider may degrade the widget, never the site.
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
          frame: ['https://challenges.example.test'],
          connect: ['https://api.example.test'],
        },
      }),
    );
    await expect(readCaptchaCspSources()).resolves.toEqual({
      script: ['https://challenges.example.test'],
      frame: ['https://challenges.example.test'],
      connect: ['https://api.example.test'],
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

  it('returns empty sources when no provider is installed', async () => {
    mockFetch(() => json({ configured: false, sources: {} }));
    await expect(readCaptchaCspSources()).resolves.toEqual({
      script: [],
      frame: [],
      connect: [],
    });
  });

  it('never throws when the kernel is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    await expect(readCaptchaCspSources()).resolves.toEqual({
      script: [],
      frame: [],
      connect: [],
    });
  });

  it('caches the result, including a failed read', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json({ sources: { connect: ['https://a.test'] } })));
    vi.stubGlobal('fetch', fetchMock);
    await readCaptchaCspSources();
    await readCaptchaCspSources();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json({ sources: {} })));
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([readCaptchaCspSources(), readCaptchaCspSources()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
