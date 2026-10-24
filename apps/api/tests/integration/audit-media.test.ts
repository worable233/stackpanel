import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { getPrisma } from '../../src/plugins/prisma.ts';
import { checkDbAvailable } from '../helpers.ts';
import { createTestUser } from '../auth-helpers.ts';

const dbAvailable = await checkDbAvailable();

/**
 * AUDIT PoC: does the media upload surface trust a browser-supplied
 * `Content-Type: image/png` when the bytes are HTML? The stored type must come
 * from magic bytes, never the header.
 */
describe.skipIf(!dbAvailable)('AUDIT media type confusion', () => {
  let app: FastifyInstance;
  let dataDir = '';
  const suffix = Date.now();
  const email = `audit_media_${suffix}@example.com`;
  const password = 'IntegrationPass123';
  let token = '';
  let userId = '';

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(process.cwd(), '.sp-audit-media-'));
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    app = buildApp();
    await app.ready();
    await app.pluginRuntime.activate('login');
    const user = await createTestUser(app, email, password);
    token = user.token;
    userId = user.userId;
  });

  afterAll(async () => {
    await getPrisma().attachment.deleteMany({ where: { ownerId: userId } });
    await getPrisma().user.deleteMany({ where: { email } });
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects HTML bytes labelled image/png', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/media?filename=evil.png&visibility=public',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
      payload: Buffer.from('<html><script>alert(document.domain)</script></html>'),
    });
    const evidence = { status: res.statusCode, body: res.body };
    const { appendFileSync } = await import('node:fs');
    appendFileSync('/tmp/audit-media-evidence.jsonl', `${JSON.stringify(evidence)}\n`);
    expect(res.statusCode).toBe(415);
  });

  it('never serves an uploaded SVG inline', async () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const up = await app.inject({
      method: 'POST',
      url: '/media?filename=evil.svg&visibility=public',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/svg+xml' },
      payload: svg,
    });
    expect(up.statusCode).toBe(201);
    const id = (up.json() as { attachment: { id: string } }).attachment.id;
    const got = await app.inject({ method: 'GET', url: `/media/${id}/content` });
    const evidence = {
      status: got.statusCode,
      contentType: got.headers['content-type'],
      disposition: got.headers['content-disposition'],
      nosniff: got.headers['x-content-type-options'],
    };
    const { appendFileSync } = await import('node:fs');
    appendFileSync('/tmp/audit-media-evidence.jsonl', `${JSON.stringify(evidence)}\n`);
    expect(got.headers['content-disposition']).toContain('attachment');
  });
});
