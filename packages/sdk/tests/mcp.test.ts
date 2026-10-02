import { describe, expect, it } from 'vitest';
import {
  buildMcpApiCall,
  buildMcpTool,
  buildMcpTools,
  isMcpWriteAuthorized,
  mcpToolName,
  McpServer,
  McpToolInputError,
  MCP_WRITE_SCOPE,
  type McpCapability,
  type McpToolResult,
} from '../src/mcp.js';

const readCap: McpCapability = {
  id: 'store.orders.list',
  method: 'GET',
  path: '/api/v1/store/orders',
  scope: 'store.view',
  summary: 'List orders',
  mutating: false,
  pluginId: 'store',
};

const writeCap: McpCapability = {
  id: 'ticket.create',
  method: 'POST',
  path: '/api/v1/tickets/:id/messages',
  scope: 'ticket.create',
  summary: 'Reply to a ticket',
  mutating: true,
  pluginId: 'ticket',
};

describe('mcp tool derivation', () => {
  it('normalizes capability ids into stable tool names', () => {
    expect(mcpToolName('store.orders.list')).toBe('store_orders_list');
    expect(mcpToolName('a/b:c')).toBe('a_b_c');
  });

  it('builds a tool descriptor carrying the capability id and annotations', () => {
    const tool = buildMcpTool(readCap);
    expect(tool.name).toBe('store_orders_list');
    expect(tool.capabilityId).toBe('store.orders.list');
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.inputSchema.type).toBe('object');
    // Read tools expose no idempotency key.
    expect(tool.inputSchema.properties).not.toHaveProperty('idempotencyKey');
  });

  it('exposes an idempotency key only for mutating tools', () => {
    const tool = buildMcpTool(writeCap);
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.inputSchema.properties).toHaveProperty('idempotencyKey');
  });

  it('exposes read-only tools to a token without mcp.write', () => {
    const tools = buildMcpTools([readCap, writeCap], new Set());
    expect(tools.map((t) => t.name)).toEqual(['store_orders_list']);
  });

  it('exposes mutating tools only with an explicit mcp.write grant', () => {
    const tools = buildMcpTools([readCap, writeCap], new Set([MCP_WRITE_SCOPE]));
    expect(tools.map((t) => t.name)).toEqual(['store_orders_list', 'ticket_create']);
  });

  it('treats an interactive session (null scopes) as write-authorized', () => {
    expect(isMcpWriteAuthorized(null)).toBe(true);
    expect(isMcpWriteAuthorized(new Set())).toBe(false);
  });
});

describe('mcp api call mapping', () => {
  it('substitutes path params and appends query params', () => {
    const call = buildMcpApiCall(writeCap, {
      params: { id: 'abc 123' },
      query: { limit: 10, tag: ['a', 'b'] },
      body: { content: 'hi' },
      idempotencyKey: 'k-123',
    });
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/api/v1/tickets/abc%20123/messages?limit=10&tag=a&tag=b');
    expect(call.body).toEqual({ content: 'hi' });
    expect(call.idempotencyKey).toBe('k-123');
  });

  it('rejects a call missing a required path param', () => {
    expect(() => buildMcpApiCall(writeCap, {})).toThrow(McpToolInputError);
  });

  it('omits a body for GET and drops undefined query values', () => {
    const call = buildMcpApiCall(readCap, {
      query: { page: 1, skip: undefined },
      body: { ignored: true },
    });
    expect(call.path).toBe('/api/v1/store/orders?page=1');
    expect(call.body).toBeUndefined();
  });
});

describe('mcp JSON-RPC server', () => {
  function server(execute: (name: string, args: unknown) => McpToolResult) {
    return new McpServer({
      serverInfo: { name: 'test', version: '1.0.0' },
      listTools: () => buildMcpTools([readCap], null),
      callTool: (name, args) => execute(name, args),
    });
  }

  it('answers initialize with protocol version and server info', async () => {
    const res = await server(() => ({ content: [{ type: 'text', text: 'x' }] })).handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    const body = res as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('test');
    expect(body.result.protocolVersion).toBe('2025-06-18');
  });

  it('lists tools derived from capabilities', async () => {
    const res = (await server(() => ({ content: [] })).handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    })) as { result: { tools: Array<{ name: string }> } };
    expect(res.result.tools.map((t) => t.name)).toEqual(['store_orders_list']);
  });

  it('dispatches tools/call and returns the executor result', async () => {
    const res = (await server((name) => ({
      content: [{ type: 'text', text: `called ${name}` }],
    })).handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'store_orders_list', arguments: {} },
    })) as { result: McpToolResult };
    expect(res.result.content[0]?.text).toBe('called store_orders_list');
  });

  it('returns an error for an unknown tool', async () => {
    const res = (await server(() => ({ content: [] })).handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    })) as { error: { code: number; message: string } };
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain('Unknown tool');
  });

  it('returns method-not-found for unsupported methods', async () => {
    const res = (await server(() => ({ content: [] })).handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/list',
    })) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });

  it('returns null for notifications (no id)', async () => {
    const res = await server(() => ({ content: [] })).handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(res).toBeNull();
  });

  it('handles a batch and omits notification members', async () => {
    const res = await server(() => ({ content: [] })).handle([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);
    expect(Array.isArray(res)).toBe(true);
    expect((res as unknown[]).length).toBe(1);
  });
});
