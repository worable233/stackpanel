import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
// Only the local MCP adapter can dispatch audience-bound OAuth tokens into HTTP tools.
const key = randomBytes(32);
export function mcpDispatchProof(method: string, url: string, credential: string, ip: string, at = Date.now()): string {
  return `${at}.${createHmac('sha256', key).update(JSON.stringify([at, method, url, credential, ip])).digest('hex')}`;
}
export function validMcpDispatch(request: FastifyRequest): boolean {
  const proof = request.headers['x-stackpanel-mcp-dispatch'];
  if (typeof proof !== 'string' || !/^\d{13}\.[a-f0-9]{64}$/.test(proof)) return false;
  const at = Number(proof.split('.')[0]);
  if (Math.abs(Date.now() - at) > 5000) return false;
  const expected = mcpDispatchProof(request.method, request.url, request.headers.authorization ?? request.headers.cookie ?? '', request.ip, at);
  return timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
}
