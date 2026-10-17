import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  server: { id: 'fixture', enabled: true, revision: 2, url: 'https://mcp.example/tools' },
  http: vi.fn(),
}));
vi.mock('../../src/plugins/prisma.ts', () => ({ getPrisma: () => ({
  agentMcpServer: { findUnique: async () => fixture.server },
  secret: { findUnique: async () => ({ ciphertext: 'encrypted' }) },
}) }));
vi.mock('../../src/lib/crypto.ts', () => ({ decryptSecret: () => 'private-credential' }));
vi.mock('../../src/agent/http.ts', async (original) => ({
  ...await original<object>(), agentHttp: fixture.http,
}));
import { externalRpc } from '../../src/agent/external.ts';

beforeEach(() => { fixture.http.mockReset(); });

it('negotiates a fresh MCP session, forwards its identifier and keeps credentials out of tool parameters', async () => {
  const requests: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
  fixture.http.mockImplementation(async (_url, body, headers) => {
    requests.push({ body: structuredClone(body), headers: { ...headers } });
    if (body.method === 'initialize') return { status: 200, headers: { 'mcp-session-id': 'session-1' },
      text: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }) };
    if (body.method === 'notifications/initialized') return { status: 202, headers: {}, text: '' };
    return { status: 200, headers: {}, text: `data: ${JSON.stringify({ id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } })}\n\n` };
  });
  expect(await externalRpc('owner', 'fixture', 'tools/call', { name: 'inspect', arguments: { value: 1 } }, undefined, 2))
    .toEqual({ content: [{ type: 'text', text: 'ok' }] });
  expect(requests.map((row) => row.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
  expect(requests[1]?.body).not.toHaveProperty('id');
  expect(requests[2]?.headers).toMatchObject({ authorization: 'Bearer private-credential', 'mcp-session-id': 'session-1', 'mcp-protocol-version': '2025-03-26' });
  expect(JSON.stringify(requests.map((row) => row.body))).not.toContain('private-credential');
});

it('rejects incompatible protocol versions and changed revisions before executing tools', async () => {
  fixture.http.mockImplementation(async (_url, body) => ({ status: 200, headers: {}, text: JSON.stringify({ id: body.id, result: { protocolVersion: 'unknown' } }) }));
  await expect(externalRpc('owner', 'fixture', 'tools/call', {}, undefined, 1)).rejects.toMatchObject({ code: 'agent.mcp_revision_changed' });
  expect(fixture.http).not.toHaveBeenCalled();
  await expect(externalRpc('owner', 'fixture', 'tools/call', {}, undefined, 2)).rejects.toMatchObject({ code: 'agent.mcp_protocol' });
  expect(fixture.http).toHaveBeenCalledTimes(1);
});
