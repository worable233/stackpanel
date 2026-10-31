import { describe, expect, it } from 'vitest';
import type { McpApiCall, McpCapability } from '@stackpanel/sdk';
import { createMcpServer } from '../../src/mcp/server.ts';

/**
 * `mcpToolName` is lossy: `.`, `:`, `/` and `_` all become `_`. Two distinct
 * capabilities can therefore normalise onto one name. These tests pin the
 * routing invariant of `POST /mcp`: a `tools/call` must execute exactly the
 * capability whose advertised name the client used — never a neighbour that
 * merely happens to share its normalised form.
 */
function capabilities(ids: string[]): McpCapability[] {
  return ids.map((id) => ({
    id,
    method: 'GET',
    path: `/api/v1/probe/${encodeURIComponent(id)}`,
    scope: null,
    summary: `probe ${id}`,
    mutating: false,
  }));
}

function serverFor(ids: string[]) {
  const executed: McpApiCall[] = [];
  const server = createMcpServer({
    capabilities: capabilities(ids),
    grantedScopes: null,
    execute: async (call) => {
      executed.push(call);
      return { statusCode: 200, contentType: 'application/json', body: '{"ok":true}' };
    },
  });
  return { server, executed };
}

async function listNames(server: ReturnType<typeof createMcpServer>): Promise<string[]> {
  const response = (await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  })) as { result?: { tools?: { name: string; capabilityId: string }[] } };
  return (response.result?.tools ?? []).map((tool) => tool.name);
}

async function callTool(
  server: ReturnType<typeof createMcpServer>,
  name: string,
): Promise<unknown> {
  return server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: {} },
  });
}

describe('mcp tool name routing', () => {
  it('routes each colliding name back to its own capability', async () => {
    const ids = ['store.orders.list', 'store_orders_list', 'store:orders:list'];
    const { server, executed } = serverFor(ids);

    expect(await listNames(server)).toEqual([
      'store_orders_list',
      'store_orders_list__2',
      'store_orders_list__3',
    ]);

    for (const [index, name] of [
      'store_orders_list',
      'store_orders_list__2',
      'store_orders_list__3',
    ].entries()) {
      const result = (await callTool(server, name)) as { result?: unknown; error?: unknown };
      expect(result.error).toBeUndefined();
      // The executed path must carry the id of *this* capability, not a sibling.
      expect(executed.at(-1)?.path).toBe(`/api/v1/probe/${encodeURIComponent(ids[index] as string)}`);
    }
  });

  it('keeps the plain name for a non-colliding capability set', async () => {
    const { server } = serverFor(['store.orders.list', 'ticket.create']);
    expect(await listNames(server)).toEqual(['store_orders_list', 'ticket_create']);
  });

  it('rejects an unknown tool instead of falling back to a sibling', async () => {
    const { server, executed } = serverFor(['store.orders.list', 'store_orders_list']);
    const result = (await callTool(server, 'store_orders_list__9')) as {
      error?: { message?: string };
    };
    expect(result.error?.message).toContain('Unknown tool');
    expect(executed).toHaveLength(0);
  });
});
