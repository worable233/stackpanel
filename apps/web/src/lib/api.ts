import 'server-only';
import { headers } from 'next/headers';
import { ApiClient } from '@stackpanel/sdk';
import { getSessionToken } from './auth';
import { createResilientFetch, parseResilienceConfig } from './resilience';
import { kernelAssetUrl } from './kernel-asset-url';

function baseUrl(): string {
  return process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
}

/**
 * One resilient transport per web process (ADR-0015 §4). The circuit breaker is
 * stateful, so it must be shared across every BFF call rather than rebuilt per
 * request — building it once here is what makes the breaker effective.
 *
 * The wrapper enforces the per-attempt timeout itself (a fresh controller per
 * attempt, so retries work); `ApiClient` gets a generous aggregate budget that
 * covers attempts + backoff, and never trips before a single attempt could.
 */
const resilience = parseResilienceConfig();
const aggregateTimeoutMs = resilience.enabled
  ? // Cover every attempt plus its backoff, with headroom, so the SDK's outer
    // abort never pre-empts a retry the wrapper intended to make.
    resilience.timeoutMs * resilience.retry.attempts +
    resilience.retry.maxDelayMs * resilience.retry.attempts +
    2_000
  : resilience.timeoutMs;

/**
 * Headers that describe the *original* client to the kernel.
 *
 * The BFF is a reverse proxy, so without this every visitor reaches the kernel
 * from one address and per-IP limits (rate limits, code-send quotas, captcha
 * remote-IP checks) collapse into a single global bucket: one attacker locks out
 * the whole site, which is exactly the failure the audit flagged (M-4).
 *
 * We forward what the browser's request already carries and never invent it —
 * the kernel only honours `X-Forwarded-For` from a peer listed in
 * `API_TRUST_PROXY`, and it resolves right-to-left, so a spoofed left-hand entry
 * is discarded.
 */
async function clientForwardingHeaders(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const incoming = await headers();
    const forwardedFor = incoming.get('x-forwarded-for')?.trim();
    const realIp = incoming.get('x-real-ip')?.trim();
    if (forwardedFor) out['x-forwarded-for'] = forwardedFor;
    else if (realIp) out['x-forwarded-for'] = realIp;
    const proto = incoming.get('x-forwarded-proto')?.trim();
    if (proto) out['x-forwarded-proto'] = proto;
    const host = incoming.get('x-forwarded-host')?.trim();
    if (host) out['x-forwarded-host'] = host;
  } catch {
    // Outside a request scope (build time, background work) there is no client.
  }
  return out;
}

/**
 * Kernel egress that carries the caller's address along.
 *
 * Header precedence: an explicit header wins, so nothing a caller sets is
 * overwritten. `next/headers` is resolved per call (not once), which keeps the
 * module-level client and the shared circuit breaker intact while still binding
 * each call to its own request.
 */
const upstreamFetch: typeof fetch = async (input, init) => {
  const extra = await clientForwardingHeaders();
  if (Object.keys(extra).length === 0) return fetch(input, init);
  const request = input instanceof Request ? input : undefined;
  const merged = new Headers(request?.headers);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, name) => merged.set(name, value));
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!merged.has(name)) merged.set(name, value);
  }
  return fetch(input, { ...init, headers: merged });
};

const transport = resilience.enabled
  ? createResilientFetch({
      timeoutMs: resilience.timeoutMs,
      retry: resilience.retry,
      circuit: resilience.circuit,
      fetchImpl: upstreamFetch,
    })
  : upstreamFetch;

/**
 * The single browser-facing egress into the kernel: the web BFF route
 * `app/api/plugins/[...path]/route.ts` forwards `/api/plugins/<kernel-path>` to
 * `{API_BASE_URL}/<kernel-path>` (same-origin, binary-safe, session-aware).
 *
 * Re-exported from a client-safe module so client components can build asset URLs
 * without importing this server-only file.
 */
export { KERNEL_BFF_PREFIX } from './kernel-asset-url';

/**
 * Resolve a kernel-relative resource path (e.g. `/themes/x/assets/logo.svg`) to a
 * same-origin URL served by the web BFF.
 *
 * Browser-facing URLs must never embed `API_BASE_URL`: it is a server-only,
 * host-local address, so any browser (not on the server host) would try to reach
 * its own machine. The BFF is the only way the browser reaches kernel resources.
 */
export function apiAssetUrl(assetPath: string): string {
  return kernelAssetUrl(assetPath);
}

/**
 * BFF client for the StackPanel API (unauthenticated).
 * Next.js acts as a thin proxy — all business logic lives in apps/api.
 */
export function getApiClient(): ApiClient {
  return new ApiClient({
    baseUrl: baseUrl(),
    timeoutMs: aggregateTimeoutMs,
    fetchImpl: transport,
  });
}

/**
 * Public API origin for external API clients — used only in copy-paste
 * documentation (e.g. the account API-keys curl example). This is NOT the
 * server-to-server `API_BASE_URL` and NOT the same-origin BFF used for browser
 * assets: external clients call the kernel directly, so they need its
 * browser-reachable origin. Falls back to the internal base when unset.
 */
export function publicApiBaseUrl(): string {
  return (process.env.PUBLIC_API_BASE_URL ?? baseUrl()).replace(/\/+$/, '');
}

/** BFF client that attaches the current session token for protected calls. */
export async function getAuthedApiClient(): Promise<ApiClient> {
  const token = await getSessionToken();
  return new ApiClient({
    baseUrl: baseUrl(),
    timeoutMs: aggregateTimeoutMs,
    fetchImpl: transport,
    ...(token ? { token } : {}),
  });
}
