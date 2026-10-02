/**
 * MCP (Model Context Protocol) contract shared by the kernel `/mcp` endpoint
 * and the standalone `@stackpanel/mcp` stdio server (PLAN-open-platform P2).
 *
 * The whole point of the open platform is that there is exactly one definition
 * of "what can be called" — the capability registry — and every consumption
 * surface is a transport adapter over it (ADR-0001). MCP is no exception: the
 * tool list is *derived* from the same capabilities `/api/v1` serves, so the
 * two can never drift.
 *
 * What lives here is transport-agnostic:
 *   - {@link McpCapability}: the minimal capability shape MCP needs (a
 *     structural subset of the kernel `Capability`, so no coupling).
 *   - {@link buildMcpTools}: capability → MCP tool descriptors, with the
 *     "writes require an explicit grant" gate.
 *   - {@link buildMcpApiCall}: a tool call → the concrete `/api/v1` request.
 *   - {@link McpServer}: JSON-RPC 2.0 dispatch for the MCP methods we support.
 *
 * Framing (HTTP Streamable / stdio newline-delimited JSON) is left to the
 * adapter, so both surfaces exercise one implementation of the protocol.
 */
import type { HttpMethod } from './plugin.js';

/** Protocol revision this implementation speaks (Streamable HTTP). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Internal sentinel: the message was a notification and yields no response. */
const NOTIFICATION = Symbol('mcp.notification');

/** Internal control-flow error carrying a JSON-RPC error code. */
class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'McpRpcError';
  }
}

/**
 * Scope a platform token must declare to expose *mutating* tools over MCP.
 * Read-only tools need no special scope: they are already gated by the
 * capability's own scope and the owner's permissions. Writes, by contrast, are
 * opt-in — a token must be explicitly declared able to act through MCP.
 */
export const MCP_WRITE_SCOPE = 'mcp.write';

/** The subset of a capability MCP needs to build a tool. */
export interface McpCapability {
  id: string;
  method: HttpMethod;
  path: string;
  scope: string | null;
  summary: string;
  mutating: boolean;
  pluginId?: string;
}

/** Standard MCP tool annotations (a best-effort behavioural hint). */
export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** A JSON Schema fragment as surfaced to MCP clients. */
export interface McpInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** One tool as returned by `tools/list`. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: McpInputSchema;
  annotations: McpToolAnnotations;
  /** Open-platform capability this tool is derived from. */
  capabilityId: string;
  method: HttpMethod;
  path: string;
  scope: string | null;
  mutating: boolean;
  pluginId?: string;
}

/** A tool name derived from a capability id (`store.orders.list` → `store_orders_list`). */
export function mcpToolName(capabilityId: string): string {
  return capabilityId.replace(/[^A-Za-z0-9_-]+/g, '_');
}

/** Build the tool descriptor for one capability. */
export function buildMcpTool(capability: McpCapability): McpToolDescriptor {
  return {
    name: mcpToolName(capability.id),
    description: [
      capability.summary,
      `(${capability.method} ${capability.path})`,
      capability.scope ? `Requires scope: ${capability.scope}.` : 'Identity-only.',
      capability.mutating
        ? 'Mutating: the presented credential must explicitly grant MCP write access.'
        : 'Read-only.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        params: {
          type: 'object',
          description: 'Path parameters substituted into the URL, e.g. { "id": "abc" }.',
          additionalProperties: true,
        },
        query: {
          type: 'object',
          description: 'Query-string parameters appended to the URL.',
          additionalProperties: true,
        },
        body: {
          description: 'JSON request body (mutating operations only).',
        },
        ...(capability.mutating
          ? {
              idempotencyKey: {
                type: 'string',
                description:
                  'Replay-safe key for this operation. Reuse the same key to safely retry.',
              },
            }
          : {}),
      },
      additionalProperties: false,
    },
    annotations: {
      title: capability.summary,
      readOnlyHint: !capability.mutating,
      destructiveHint: capability.mutating,
      idempotentHint: !capability.mutating,
      openWorldHint: false,
    },
    capabilityId: capability.id,
    method: capability.method,
    path: capability.path,
    scope: capability.scope,
    mutating: capability.mutating,
    ...(capability.pluginId ? { pluginId: capability.pluginId } : {}),
  };
}

/**
 * Whether the presented credential may call mutating tools.
 *
 * `null` means the caller is not a scoped platform token (an interactive
 * session owner), so it already carries the owner's full authority and may
 * write. A token must declare {@link MCP_WRITE_SCOPE}.
 */
export function isMcpWriteAuthorized(
  grantedScopes: ReadonlySet<string> | null,
): boolean {
  return grantedScopes === null || grantedScopes.has(MCP_WRITE_SCOPE);
}

/**
 * Capability → tool list, filtered by what the credential is allowed to do.
 *
 * Read tools are exposed for every capability the credential already holds
 * (the registry has already intersected scope with the owner's permissions).
 * Mutating tools are only exposed when {@link isMcpWriteAuthorized}.
 */
export function buildMcpTools(
  capabilities: readonly McpCapability[],
  grantedScopes: ReadonlySet<string> | null,
): McpToolDescriptor[] {
  const writesAllowed = isMcpWriteAuthorized(grantedScopes);
  return capabilities
    .filter((capability) => !capability.mutating || writesAllowed)
    .map((capability) => buildMcpTool(capability));
}

/** Arguments a client may pass to `tools/call`. */
export interface McpToolArguments {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Replay-safe key; required for mutating capabilities (see `Idempotency-Key`). */
  idempotencyKey?: string;
}

/** A resolved `/api/v1` request to execute on behalf of a tool call. */
export interface McpApiCall {
  method: HttpMethod;
  /** Path + query string (relative to the API origin). */
  path: string;
  body?: unknown;
  /** `Idempotency-Key` header value for mutating runs. */
  idempotencyKey?: string;
}

/** Raised when a tool call's arguments cannot be turned into a request. */
export class McpToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolInputError';
  }
}

function isBodyMethod(method: HttpMethod): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

/**
 * Turn a tool call into the concrete `/api/v1` request.
 *
 * `params` fills `:name` path segments (URL-encoded); `query` appends a query
 * string; `body` is sent verbatim for non-GET methods. Missing path parameters
 * are rejected rather than silently producing a wildcard request.
 */
export function buildMcpApiCall(
  capability: McpCapability,
  args: McpToolArguments = {},
): McpApiCall {
  let path = capability.path;
  for (const [key, value] of Object.entries(args.params ?? {})) {
    const token = `:${key}`;
    if (!path.includes(token)) continue;
    path = path.replace(token, encodeURIComponent(String(value)));
  }
  const missing = path.match(/:[A-Za-z0-9_]+/g);
  if (missing) {
    throw new McpToolInputError(`缺少路径参数：${missing.join(', ')}`);
  }

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(args.query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, String(item));
    } else {
      query.append(key, String(value));
    }
  }
  const qs = query.toString();

  const mutating = isBodyMethod(capability.method);
  return {
    method: capability.method,
    path: qs ? `${path}?${qs}` : path,
    ...(mutating && args.body !== undefined ? { body: args.body } : {}),
    ...(mutating && args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
  };
}

// --------------------------------------------------------------------------
// JSON-RPC 2.0 / MCP protocol dispatch
// --------------------------------------------------------------------------

export interface McpJsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface McpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: McpJsonRpcError;
}

/** One content block in a `tools/call` result. */
export interface McpToolResultContent {
  type: 'text';
  text: string;
}

/** The result of a `tools/call` invocation. */
export interface McpToolResult {
  content: McpToolResultContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Server identity advertised in `initialize`. */
export interface McpServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

export interface McpServerOptions {
  serverInfo: McpServerInfo;
  /** Tools currently visible to this credential. */
  listTools: () => Promise<McpToolDescriptor[]> | McpToolDescriptor[];
  /** Execute a tool by name; must be one of {@link McpServerOptions.listTools}. */
  callTool: (
    name: string,
    args: McpToolArguments,
  ) => Promise<McpToolResult> | McpToolResult;
}

const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): McpJsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Framework-agnostic MCP server. `handle` accepts a single JSON-RPC message or
 * a batch, and returns the response(s) — or `null` when the input was purely
 * notifications (the transport then answers `202 Accepted`, per spec).
 */
export class McpServer {
  constructor(private readonly options: McpServerOptions) {}

  /** Handle a parsed JSON-RPC message or an array of them. */
  async handle(
    input: unknown,
  ): Promise<McpJsonRpcResponse | McpJsonRpcResponse[] | null> {
    if (Array.isArray(input)) {
      if (input.length === 0) return rpcError(null, RPC_INVALID_REQUEST, 'Empty batch');
      const responses = (
        await Promise.all(input.map((message) => this.handleMessage(message)))
      ).filter((response): response is McpJsonRpcResponse => response !== null);
      return responses.length === 0 ? null : responses;
    }
    return this.handleMessage(input);
  }

  /** Handle one JSON-RPC message; `null` for notifications. */
  async handleMessage(message: unknown): Promise<McpJsonRpcResponse | null> {
    if (!isRecord(message) || message['jsonrpc'] !== '2.0' || typeof message['method'] !== 'string') {
      return rpcError(this.idOf(message), RPC_INVALID_REQUEST, 'Invalid JSON-RPC request');
    }
    const id = this.idOf(message);
    const method = message['method'];
    const params = message['params'];
    const isNotification = message['id'] === undefined;

    try {
      const result = await this.dispatch(method, params);
      // Notifications never receive a response.
      if (isNotification || result === NOTIFICATION) return null;
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (isNotification) return null;
      if (error instanceof McpRpcError) return rpcError(id, error.code, error.message);
      return rpcError(
        id,
        RPC_INTERNAL_ERROR,
        error instanceof Error ? error.message : 'Internal error',
      );
    }
  }

  private idOf(message: unknown): string | number | null {
    if (!isRecord(message)) return null;
    const id = message['id'];
    return typeof id === 'string' || typeof id === 'number' ? id : null;
  }

  private async dispatch(
    method: string,
    params: unknown,
  ): Promise<unknown | typeof NOTIFICATION> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: this.options.serverInfo.name,
            version: this.options.serverInfo.version,
          },
          ...(this.options.serverInfo.instructions
            ? { instructions: this.options.serverInfo.instructions }
            : {}),
        };
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return NOTIFICATION;
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: await this.options.listTools() };
      case 'tools/call': {
        if (!isRecord(params) || typeof params['name'] !== 'string') {
          throw new McpRpcError(RPC_INVALID_PARAMS, 'tools/call requires a tool name');
        }
        const name = params['name'];
        const tools = await this.options.listTools();
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) {
          // Unknown or not-visible-to-this-credential: indistinguishable on
          // purpose, so a write-hidden tool cannot be probed into existence.
          throw new McpRpcError(RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
        }
        const rawArgs = params['arguments'];
        const args: McpToolArguments = isRecord(rawArgs)
          ? (rawArgs as McpToolArguments)
          : {};
        return this.options.callTool(name, args);
      }
      default:
        throw new McpRpcError(RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }
}
