import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';

describe('health routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      status: string;
      version: string;
      apiVersion: string;
      uptime: number;
    };
    expect(body.status).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.apiVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof body.uptime).toBe('number');
  });

  it('GET /ready degrades gracefully when DB is unreachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    // Ready only when every required round-trip succeeds; otherwise 503.
    expect([200, 503]).toContain(res.statusCode);
    const body = res.json() as { status: string; database: string };
    if (res.statusCode === 503) {
      expect(body.status).toBe('degraded');
    } else {
      expect(body.status).toBe('ready');
      expect(body.database).toBe('ok');
    }
  });
});
