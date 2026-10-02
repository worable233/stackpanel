/**
 * MCP server assembly (PLAN-open-platform P2).
 *
 * `createMcpServer` binds the transport-agnostic {@link McpServer} to a
 * capability source and an executor, and `createRequestMcpRuntime` wires a live
 * Fastify request into that shape. Both the `/mcp` HTTP endpoint and the stdio
 * client server use this same assembly, so a tool behaves identically whichever
 * transport an agent chooses.
 */
import type { FastifyRequest } from 'fastify';
import {
  buildMcpApiCall,
  buildMcpTools,
  isMcpWriteAuthorized,
  McpServer,
  McpToolInputError,
  mcpToolName,
  type McpApiCall,
  type McpCapability,
  type McpToolResult,
} from '@stackpanel/sdk';
import { MCP_SERVER_INFO, mcpCapabilitiesFor, mcpGrantedScopes } from './registry.ts';

/** Raw HTTP outcome of executing one tool call through the API stack. */
export interface McpExecutionResult {
  statusCode: number;
  contentType: string;
  /** Response body as text (JSON string for the open API). */
  body: string;
}

/** Executes an already-resolved `/api/v1` call via the app's own HTTP stack. */
export type McpExecutor = (call: McpApiCall) => Promise<McpExecutionResult>;

/** Everything needed to serve MCP for one credential. */
export interface McpToolRuntime {
  capabilities: readonly McpCapability[];
  /** Scopes on the credential, or `null` for an interactive session. */
  grantedScopes: ReadonlySet<string> | null;
  execute: McpExecutor;
}

/** Build a JSON-RPC MCP server over a credential-scoped tool runtime. */
export function createMcpServer(runtime: McpToolRuntime): McpServer {
  const writesAllowed = isMcpWriteAuthorized(runtime.grantedScopes);
  const visibleCapabilities = runtime.capabilities.filter(
    (capability) => !capability.mutating || writesAllowed,
  );
  const tools = buildMcpTools(runtime.capabilities, runtime.grantedScopes);
  const capabilitiesByName = new Map(
    visibleCapabilities.map((capability) => [mcpToolName(capability.id), capability]),
  );

  return new McpServer({
    serverInfo: MCP_SERVER_INFO,
    listTools: () => tools,
    callTool: async (name, args) => {
      const capability = capabilitiesByName.get(name);
      if (!capability) throw new McpToolInputError(`Unknown tool: ${name}`);

      let call: McpApiCall;
      try {
        call = buildMcpApiCall(capability, args);
      } catch (error) {
        return errorResult(error);
      }

      if (capability.mutating && !writesAllowed) {
        return errorResult(
          new McpToolInputError(
            `该工具会修改状态，需要凭证显式授予 MCP 写权限（scope: mcp.write）。`,
          ),
        );
      }
      if (capability.mutating && !call.idempotencyKey) {
        return errorResult(
          new McpToolInputError('写操作必须提供 idempotencyKey（对应 Idempotency-Key 请求头）。'),
        );
      }

      const outcome = await runtime.execute(call);
      if (outcome.statusCode >= 400) {
        return {
          content: [{ type: 'text', text: `${outcome.statusCode} ${outcome.body}` }],
          isError: true,
        };
      }
      return shapeSuccess(outcome);
    },
  });
}

/** A `tools/call` result carrying a structured, machine-readable error. */
function errorResult(error: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : 'Invalid tool call' }],
    isError: true,
  };
}

/** Wrap a successful HTTP body as both text content and structured output. */
function shapeSuccess(outcome: McpExecutionResult): McpToolResult {
  let parsed: unknown;
  const isJson = outcome.contentType.includes('application/json');
  if (isJson) {
    try {
      parsed = JSON.parse(outcome.body);
    } catch {
      parsed = undefined;
    }
  }
  return {
    content: [{ type: 'text', text: outcome.body }],
    ...(parsed !== undefined ? { structuredContent: parsed } : {}),
  };
}

/** Assemble a credential-scoped runtime for a live request. */
export function createRequestMcpRuntime(
  request: FastifyRequest,
  execute: McpExecutor,
): McpToolRuntime {
  return {
    capabilities: mcpCapabilitiesFor(request),
    grantedScopes: mcpGrantedScopes(request),
    execute,
  };
}

/** Serve a JSON-RPC payload for a request: returns the response, or `null`. */
export async function handleMcpRequest(
  request: FastifyRequest,
  execute: McpExecutor,
): Promise<unknown> {
  const server = createMcpServer(createRequestMcpRuntime(request, execute));
  return server.handle(request.body);
}
