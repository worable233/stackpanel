import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePublicAddresses } from '@stackpanel/net-guard';
import { pinnedFetch } from './webhook';

/**
 * H-3 regression: the delivery sink must connect to the address that was
 * validated for SSRF, not re-resolve the hostname (which a DNS-rebinding
 * attacker controls). `pinnedFetch` now takes that validated address directly,
 * so a hostname that does not resolve still receives a request.
 */
describe('reseller webhook pinned fetch', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  function listen(): Promise<{ server: Server; port: number; hostHeader: () => string }> {
    let host = '';
    const server = createServer((req, res) => {
      host = String(req.headers.host ?? '');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('no port');
        resolve({ server, port: address.port, hostHeader: () => host });
      });
    });
  }

  it('connects to the pinned address without re-resolving the hostname', async () => {
    const { port, hostHeader } = await listen();
    // A hostname that does NOT resolve: if pinnedFetch re-resolved, this would
    // throw a DNS error instead of reaching the local server.
    const response = await pinnedFetch(
      `http://webhook.invalid:${port}/hook`,
      { method: 'POST', body: '{}' },
      ['127.0.0.1'],
    );
    expect(response.status).toBe(200);
    // Host/SNI must be preserved so upstream virtual-host routing still works.
    expect(hostHeader()).toBe(`webhook.invalid:${port}`);
  });

  it('resolvePublicAddresses rejects a private target before any connection', async () => {
    expect(await resolvePublicAddresses('127.0.0.1')).toBeNull();
    expect(await resolvePublicAddresses('webhook.invalid')).toBeNull();
  });
});
