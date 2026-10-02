/**
 * Streamable HTTP transport for the MCP stdio bridge (PLAN-open-platform P2).
 *
 * Each client message becomes a `POST /mcp` with the platform credential in the
 * `Authorization` header (the "sticky token" model). The server answers either
 * `application/json` (single response) or `text/event-stream` (one JSON-RPC
 * message per SSE event); both are accepted. Notifications yield `202 Accepted`
 * with no body, which the bridge maps to "nothing to emit".
 */
import type { McpTransportCall } from './bridge.js';

export interface HttpTransportOptions {
  /** Base API origin, e.g. `http://127.0.0.1:3001`. A trailing `/mcp` is optional. */
  baseUrl: string;
  /** Platform API token (`sp_…`). */
  token: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/** Resolve the `/mcp` endpoint from a base URL or a full endpoint URL. */
export function mcpEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/mcp') ? trimmed : `${trimmed}/mcp`;
}

export function createHttpTransport(options: HttpTransportOptions): McpTransportCall {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = mcpEndpoint(options.baseUrl);

  return async (message) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify(message),
    });

    if (response.status === 202 || response.status === 204) return null;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    if (text.length === 0) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) return parseSse(text);
    return JSON.parse(text) as unknown;
  };
}

/**
 * Extract the JSON-RPC payload from an SSE response. The MCP Streamable HTTP
 * transport emits one message per `data:` event; a batch may span several, in
 * which case we return the array in arrival order.
 */
export function parseSse(body: string): unknown {
  const payloads: unknown[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
      .trim();
    if (data.length === 0) continue;
    payloads.push(JSON.parse(data) as unknown);
  }
  if (payloads.length === 0) return null;
  return payloads.length === 1 ? payloads[0] : payloads;
}
