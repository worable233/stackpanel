import { describe, expect, it, vi } from 'vitest';
import { createMcpBridge, runStdio } from '../src/bridge.js';
import { createHttpTransport, mcpEndpoint, parseSse } from '../src/http-client.js';
import { parseCliOptions } from '../src/cli.js';

async function* chunks(...values: string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

function collector() {
  let output = '';
  return {
    output: { write: (chunk: string) => (output += chunk) },
    get value() {
      return output;
    },
  };
}

describe('mcp stdio bridge framing', () => {
  it('parses newline-delimited messages and serializes responses', async () => {
    const call = vi.fn(async (message: unknown) => ({ jsonrpc: '2.0', id: (message as { id: number }).id, result: {} }));
    const sink = collector();
    await runStdio({ call, input: chunks('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'), output: sink.output });
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sink.value.trim())).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('buffers a message split across chunks', async () => {
    const call = vi.fn(async () => ({ jsonrpc: '2.0', id: 1, result: {} }));
    const sink = collector();
    await runStdio({
      call,
      input: chunks('{"jsonrpc":"2.0","id":1,', '"method":"ping"}\n'),
      output: sink.output,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(sink.value.endsWith('\n')).toBe(true);
  });

  it('emits nothing for notifications (null transport response)', async () => {
    const bridge = createMcpBridge(async () => null);
    expect(await bridge.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeNull();
  });

  it('returns a parse error for malformed JSON without calling the transport', async () => {
    const call = vi.fn(async () => null);
    const bridge = createMcpBridge(call);
    const out = await bridge.handleLine('{not json');
    expect(call).not.toHaveBeenCalled();
    expect(JSON.parse(out ?? '{}').error.code).toBe(-32700);
  });
});

describe('mcp http transport', () => {
  it('normalizes the endpoint whether or not /mcp is present', () => {
    expect(mcpEndpoint('http://x:3001')).toBe('http://x:3001/mcp');
    expect(mcpEndpoint('http://x:3001/')).toBe('http://x:3001/mcp');
    expect(mcpEndpoint('http://x:3001/mcp')).toBe('http://x:3001/mcp');
  });

  it('posts with the sticky bearer token and parses a JSON response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const call = createHttpTransport({ baseUrl: 'http://x:3001', token: 'sp_abc', fetchImpl });
    const response = await call({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(response).toMatchObject({ id: 1 });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x:3001/mcp',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer sp_abc' }),
      }),
    );
  });

  it('maps 202 Accepted to null (notification)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const call = createHttpTransport({ baseUrl: 'http://x:3001', token: 't', fetchImpl });
    expect(await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('throws on a transport error status', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const call = createHttpTransport({ baseUrl: 'http://x:3001', token: 't', fetchImpl });
    await expect(call({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow('MCP HTTP 500');
  });

  it('parses an SSE response', () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    expect(parseSse(body)).toMatchObject({ id: 1 });
    expect(parseSse('')).toBeNull();
  });
});

describe('mcp cli options', () => {
  it('reads url and token from the environment', () => {
    const options = parseCliOptions([], {
      STACKPANEL_API_URL: 'https://panel.example.com',
      STACKPANEL_API_TOKEN: 'sp_x',
    });
    expect(options).toEqual({ baseUrl: 'https://panel.example.com', token: 'sp_x' });
  });

  it('lets flags override the environment', () => {
    const options = parseCliOptions(['--url', 'http://localhost:3001', '--token=sp_y'], {});
    expect(options).toEqual({ baseUrl: 'http://localhost:3001', token: 'sp_y' });
  });

  it('throws when the base URL is missing', () => {
    expect(() => parseCliOptions([], { STACKPANEL_API_TOKEN: 'sp_x' })).toThrow('缺少 API 地址');
  });

  it('throws when the token is missing', () => {
    expect(() => parseCliOptions([], { STACKPANEL_API_URL: 'http://x' })).toThrow('缺少平台凭证');
  });
});
