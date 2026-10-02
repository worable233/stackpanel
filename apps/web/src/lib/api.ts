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

/** Resolve an API-relative asset path (e.g. `/themes/x/assets/logo.svg`) to an absolute URL. */
export function apiAssetUrl(assetPath: string): string {
  if (!assetPath) return '';
  if (/^https?:\/\//.test(assetPath)) return assetPath;
  return `${baseUrl()}${assetPath.startsWith('/') ? '' : '/'}${assetPath}`;
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
