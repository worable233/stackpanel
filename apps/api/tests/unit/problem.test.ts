import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';

/**
 * RFC 7807 problem-details contract (ADR-0012).
 *
 * The `onSend` normaliser must reshape every error response into
 * `application/problem+json` with a stable `code`, a `requestId`, and an
 * `instance`. The legacy `error` member is no longer emitted.
 */
describe('problem details (ADR-0012)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('normalises an unseen route into problem+json with a stable code', async () => {
    const res = await app.inject({ method: 'GET', url: '/definitely-not-a-route' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json() as {
      type: string;
      title: string;
      status: number;
      code: string;
      detail?: string;
      instance: string;
      requestId: string;
      error?: string;
    };
    expect(body.status).toBe(404);
    expect(body.code).toBe('request.not_found');
    expect(body.type).toContain('errors.stackpanel.dev');
    expect(body.instance).toBe('/definitely-not-a-route');
    expect(typeof body.requestId).toBe('string');
    // Compatibility window closed: legacy field must be gone.
    expect(body.error).toBeUndefined();
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('maps an authenticated route without credentials to a 401 problem', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/api-tokens' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json() as { status: number; code: string; detail?: string; error?: string };
    expect(body.status).toBe(401);
    expect(typeof body.code).toBe('string');
    expect(body.code.length).toBeGreaterThan(0);
    expect(body.error).toBeUndefined();
  });
});
