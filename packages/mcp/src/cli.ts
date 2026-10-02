/**
 * `npx @stackpanel/mcp` entry point (PLAN-open-platform P2).
 *
 * Usage:
 *   STACKPANEL_API_URL=https://panel.example.com STACKPANEL_API_TOKEN=sp_… npx @stackpanel/mcp
 *
 * Flags override the environment. The bridge speaks MCP over stdio and dials
 * the server's Streamable HTTP `/mcp` endpoint, so agents that only support
 * local stdio servers still get the platform's capability-derived tools.
 */
import { runStdio } from './bridge.js';
import { createHttpTransport } from './http-client.js';

interface CliOptions {
  baseUrl: string;
  token: string;
}

/** Parse argv + env; throws (with a Chinese message) on missing essentials. */
export function parseCliOptions(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): CliOptions {
  let baseUrl = env.STACKPANEL_API_URL ?? env.STACKPANEL_API_BASE_URL ?? '';
  let token = env.STACKPANEL_API_TOKEN ?? '';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    if (arg === '--url' && next) {
      baseUrl = next;
      i += 1;
    } else if (arg === '--token' && next) {
      token = next;
      i += 1;
    } else if (arg.startsWith('--url=')) {
      baseUrl = arg.slice('--url='.length);
    } else if (arg.startsWith('--token=')) {
      token = arg.slice('--token='.length);
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(USAGE);
    }
  }

  if (!baseUrl) {
    throw new Error('缺少 API 地址：设置 STACKPANEL_API_URL 或传入 --url <baseUrl>。');
  }
  if (!token) {
    throw new Error('缺少平台凭证：设置 STACKPANEL_API_TOKEN 或传入 --token <sp_…>。');
  }
  return { baseUrl, token };
}

const USAGE = [
  '用法：stackpanel-mcp [--url <baseUrl>] [--token <token>]',
  '',
  '环境变量：',
  '  STACKPANEL_API_URL    平台 API 基址（例如 https://panel.example.com）',
  '  STACKPANEL_API_TOKEN  平台 API 凭证（sp_…）',
].join('\n');

/** Run the stdio bridge against the configured endpoint. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliOptions(argv);
  } catch (error) {
    // Usage/--help is informational; missing config is an error. Both go to
    // stderr so they never corrupt the stdout JSON-RPC channel.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const call = createHttpTransport({ baseUrl: options.baseUrl, token: options.token });
  await runStdio({
    call,
    input: process.stdin,
    output: process.stdout,
    log: (message) => process.stderr.write(`${message}\n`),
  });
}

// Execute only when run as a program, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
