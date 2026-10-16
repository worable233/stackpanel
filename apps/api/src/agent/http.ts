import { request } from 'node:https';
import { isIP } from 'node:net';
import { isPublicHttpUrl, resolvePublicAddresses } from '@stackpanel/net-guard';
import { PluginError } from '@stackpanel/sdk';

/** Bounded, DNS-pinned HTTPS. No redirects, proxy environment or credential-bearing URL. */
export async function agentHttp(
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  if (!isPublicHttpUrl(endpoint)) throw new PluginError('agent.network_forbidden', 422, '仅允许公网 HTTPS 地址');
  const url = new URL(endpoint);
  const addresses = await resolvePublicAddresses(url.hostname);
  const address = addresses?.[0];
  if (!address) throw new PluginError('agent.network_forbidden', 422, '目标地址解析失败或包含受限网络');
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > 1024 * 1024) throw new PluginError('agent.payload_large', 413, '请求内容过大');
  const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', signal: deadline,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family: isIP(address) }]);
        else callback(null, address, isIP(address));
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { res.destroy(); req.destroy(new Error('响应内容过大')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 502, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => reject(new PluginError('agent.remote_unavailable', 502, '外部服务调用失败，请核对服务状态')));
    req.end(payload);
  });
}

/** Extract the matching JSON-RPC response from JSON or a bounded SSE message batch. */
export function rpcResult(text: string, id: string): unknown {
  const messages: unknown[] = [];
  try { messages.push(JSON.parse(text)); }
  catch {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') { try { messages.push(JSON.parse(data)); } catch { /* Ignore unrelated event data. */ } }
    }
  }
  for (const raw of messages.flat()) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as Record<string, unknown>;
    if (message.id !== id) continue;
    if (message.error) throw new PluginError('agent.mcp_error', 502, '外部 MCP 返回协议错误');
    if ('result' in message) return message.result;
  }
  throw new PluginError('agent.mcp_protocol', 502, '外部 MCP 响应格式无效');
}
