import 'server-only';
import { ApiClient } from '@stackpanel/sdk';
import { getSessionToken } from './auth';
import { createResilientFetch, parseResilienceConfig } from './resilience';

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
const transport = resilience.enabled
  ? createResilientFetch({
      timeoutMs: resilience.timeoutMs,
      retry: resilience.retry,
      circuit: resilience.circuit,
    })
  : undefined;

/**
 * The single browser-facing egress into the kernel: the web BFF route
 * `app/api/plugins/[...path]/route.ts` forwards `/api/plugins/<kernel-path>` to
 * `{API_BASE_URL}/<kernel-path>` (same-origin, binary-safe, session-aware).
 */
const KERNEL_BFF_PREFIX = '/api/plugins';

/**
 * Resolve a kernel-relative resource path (e.g. `/themes/x/assets/logo.svg`) to a
 * same-origin URL served by the web BFF.
 *
 * Browser-facing URLs must never embed `API_BASE_URL`: it is a server-only,
 * host-local address, so any browser (not on the server host) would try to reach
 * its own machine. The BFF is the only way the browser reaches kernel resources.
 */
export function apiAssetUrl(assetPath: string): string {
  if (!assetPath) return '';
  if (/^https?:\/\//.test(assetPath)) return assetPath;
  return `${KERNEL_BFF_PREFIX}${assetPath.startsWith('/') ? '' : '/'}${assetPath}`;
}

/**
 * BFF client for the StackPanel API (unauthenticated).
 * Next.js acts as a thin proxy — all business logic lives in apps/api.
 */
export function getApiClient(): ApiClient {
  return new ApiClient({
    baseUrl: baseUrl(),
    timeoutMs: aggregateTimeoutMs,
    ...(transport ? { fetchImpl: transport } : {}),
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
    ...(transport ? { fetchImpl: transport } : {}),
    ...(token ? { token } : {}),
  });
}
