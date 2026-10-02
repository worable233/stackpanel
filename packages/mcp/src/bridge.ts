/**
 * MCP stdio bridge (PLAN-open-platform P2).
 *
 * The stdio server is a pure pass-through: it reads newline-delimited JSON-RPC
 * messages from stdin, hands each to a remote transport (`POST /mcp` over
 * Streamable HTTP), and writes the response back to stdout. No protocol logic
 * is duplicated here — the same kernel that serves `/mcp` decides everything.
 * This separation also makes the framing unit-testable without a real socket.
 */

/** Sends one JSON-RPC message and returns the response, or `null` for a notification. */
export type McpTransportCall = (message: unknown) => Promise<unknown | null>;

/** Newline-delimited JSON framing over arbitrary streams. */
export interface McpBridge {
  /** Handle one line; returns the JSON to emit, or `null` when nothing is due. */
  handleLine(line: string): Promise<string | null>;
}

/** Build the line handler around a transport. */
export function createMcpBridge(call: McpTransportCall): McpBridge {
  return {
    async handleLine(line: string): Promise<string | null> {
      const trimmed = line.trim();
      if (trimmed.length === 0) return null;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
      }
      const response = await call(message);
      if (response === null || response === undefined) return null;
      return JSON.stringify(response);
    },
  };
}

export interface StdioRunOptions {
  call: McpTransportCall;
  input: AsyncIterable<Buffer | string>;
  output: { write(chunk: string): unknown };
  /** Disable buffering output until newline; mostly for tests. */
  log?: (message: string) => void;
}

/** Pump newline-delimited messages from `input` through `call` to `output`. */
export async function runStdio(options: StdioRunOptions): Promise<void> {
  const bridge = createMcpBridge(options.call);
  let buffer = '';

  const flush = async (line: string): Promise<void> => {
    const out = await bridge.handleLine(line);
    if (out !== null) options.output.write(`${out}\n`);
  };

  for await (const chunk of options.input) {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      await flush(line);
      index = buffer.indexOf('\n');
    }
  }
  if (buffer.trim().length > 0) {
    await flush(buffer);
  }
  options.log?.('stdin closed; MCP stdio bridge stopping');
}
