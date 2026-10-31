import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/app.ts';

/**
 * `GET /ready` answers 503 with its own payload, not with an error body. The
 * app-wide RFC 7807 normaliser used to rewrite it into
 * `{ code: 'internal.unavailable' }`, erasing `status`, the per-dependency
 * checks and `pendingFrontends` — i.e. exactly the diagnosis an orchestrator
 * needs when it is deciding to stop routing traffic to this replica.
 *
 * A degraded replica is reproduced without a database failure: a package whose
 * frontend manifest is present but whose compiled entry is missing is reported
 * as pending (contract 04 §4.2).
 */
describe('readiness probe payload survives error normalisation', () => {
  const previousDataDir = process.env['STACKPANEL_DATA_DIR'];
  let dataDir = '';
  let app: FastifyInstance;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'sp-ready-'));
    mkdirSync(path.join(dataDir, 'plugins', 'halfbuilt', 'frontend'), { recursive: true });
    writeFileSync(path.join(dataDir, 'plugins', 'halfbuilt', 'frontend', 'manifest.json'), '{}\n');
    process.env['STACKPANEL_DATA_DIR'] = dataDir;
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (previousDataDir === undefined) delete process.env['STACKPANEL_DATA_DIR'];
    else process.env['STACKPANEL_DATA_DIR'] = previousDataDir;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns the health payload, not a problem body', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      status?: string;
      database?: string;
      pendingFrontends?: string[];
      code?: string;
    };
    expect(body.status).toBe('degraded');
    expect(body.code).toBeUndefined();
    expect(body.database).toBe('ok');
    expect(body.pendingFrontends).toContain('plugins:halfbuilt@flat');
  });
});
