import 'server-only';
import { ApiClient } from '@stackpanel/sdk';
import { getSessionToken } from './auth';
import {
  createResilientFetch,
  parseResilienceConfig,
} from './resilience';

function baseUrl(): string {
  return process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
}

/**
 * BFF client used by the generic plugin proxy (`/api/plugins/[id]/[...path]`).
 *
 * Unlike the other BFF helpers this one is **not** per-plugin: the proxy routes
 * arbitrary plugin paths, so it never needs a plugin-specific client. Its only
 * job is to resolve the current session token (or null when anonymous) so the
 * proxy can substitute the real session for the browser's cookie. The public
 * `ApiClient` type still exposes `.token`, letting the proxy read the resolved
 * value without knowing the transport details.
 */
const resilience = parseResilienceConfig();
const transport = resilience.enabled
  ? createResilientFetch({
      timeoutMs: resilience.timeoutMs,
      retry: resilience.retry,
      circuit: resilience.circuit,
    })
  : undefined;

export async function getBffPluginClient(): Promise<ApiClient> {
  const token = await getSessionToken();
  return new ApiClient({
    baseUrl: baseUrl(),
    ...(transport ? { fetchImpl: transport } : {}),
    ...(token ? { token } : {}),
  });
}
