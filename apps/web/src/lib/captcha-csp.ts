/**
 * CSP sources for a captcha widget, read from the kernel.
 *
 * A challenge widget is third-party browser code: Turnstile renders an iframe
 * from `challenges.cloudflare.com` and its script talks back to that origin. The
 * page's policy is `default-src 'self'`, so without these origins the widget is
 * blocked and the deployment appears to require a challenge nobody can solve.
 *
 * The origins cannot be hard-coded — that would put vendor knowledge in the web
 * layer — so they come from the provider's own `clientConfig.sources`, already
 * sanitized to absolute `https:` origins by the kernel. This module only reads
 * and caches them.
 *
 * Failure policy is deliberately forgiving: an unreachable API, an uninstalled
 * plugin, or any malformed payload yields empty sources, which reproduces the
 * pre-existing policy byte for byte. Human verification must never be able to
 * take the site down — that is the whole point of shipping it as a plugin.
 */

export interface CaptchaCspSources {
  script: string[];
  style: string[];
  frame: string[];
  connect: string[];
  /** `worker-src` values a proof-of-work widget needs (currently only `blob:`). */
  worker: string[];
}

const EMPTY: CaptchaCspSources = { script: [], style: [], frame: [], connect: [], worker: [] };

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';

/**
 * The policy is static between provider reconfigurations, and the proxy runs on
 * every page request, so one cached read per window is enough. A short TTL keeps
 * an admin's "save settings" effective without a restart.
 */
const TTL_MS = 30_000;

/**
 * A **failed** read is cached only long enough to collapse a request burst.
 *
 * Caching a failure for the full window is a self-inflicted outage: the proxy
 * derives `worker-src` from this answer, so one timed-out read during an API
 * restart left every page for the next 30 seconds without `worker-src` — and a
 * proof-of-work widget's `new Worker(blob:)` is then blocked by `script-src`
 * fallback, i.e. the widget silently stops solving. Two seconds keeps the burst
 * sharing a single attempt while recovering as soon as the API is back.
 */
const FAILURE_TTL_MS = 2_000;

let cache: { at: number; value: CaptchaCspSources; ok: boolean } | null = null;
/** In-flight read, so a burst of concurrent requests shares one fetch. */
let inflight: Promise<CaptchaCspSources> | null = null;

/**
 * Only absolute https origins survive, mirroring the kernel's sanitizer. The
 * `blob:` scheme a proof-of-work worker needs goes through `normalizeWorkers`
 * instead, so it can never widen `script-src` or `frame-src`.
 */
function normalize(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const origins = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:') continue;
      origins.add(url.origin);
    } catch {
      // Not absolute: nothing to allow.
    }
  }
  return [...origins];
}

/** `worker-src` values: `blob:` is a scheme, not an origin, so it needs its own check. */
const ALLOWED_WORKER_SOURCES = new Set(['blob:']);

function normalizeWorkers(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const allowed = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (ALLOWED_WORKER_SOURCES.has(normalized)) allowed.add(normalized);
  }
  return [...allowed];
}

function pick(sources: unknown): CaptchaCspSources {
  if (!sources || typeof sources !== 'object') return EMPTY;
  const raw = sources as Record<string, unknown>;
  return {
    script: normalize(raw['script']),
    style: normalize(raw['style']),
    frame: normalize(raw['frame']),
    connect: normalize(raw['connect']),
    worker: normalizeWorkers(raw['worker']),
  };
}

/** Reset the process cache. Test-only. */
export function resetCaptchaCspCache(): void {
  cache = null;
  inflight = null;
}

/**
 * Read (and cache) the external origins the installed provider's widget needs.
 *
 * Never throws: every failure degrades to "no extra origins".
 */
export async function readCaptchaCspSources(): Promise<CaptchaCspSources> {
  const now = Date.now();
  if (cache && now - cache.at < (cache.ok ? TTL_MS : FAILURE_TTL_MS)) return cache.value;
  if (inflight) return inflight;

  inflight = (async () => {
    let value: CaptchaCspSources = EMPTY;
    let ok = false;
    try {
      const response = await fetch(`${API_BASE_URL}/captcha/policy`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { sources?: unknown } | null;
        value = pick(body?.sources);
        ok = true;
      }
    } catch {
      value = EMPTY;
    }
    cache = { at: Date.now(), value, ok };
    inflight = null;
    return value;
  })();

  return inflight;
}
