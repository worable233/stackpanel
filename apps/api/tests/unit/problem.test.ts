import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CommerceError, PaymentError } from '@stackpanel/sdk';
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
    // Probe routes for kernel-domain errors: the boundary must render the
    // error's status/code/detail through the deterministic-error brand rather
    // than collapsing a provider failure to a generic 500.
    app.get('/__test/payment-error', async () => {
      throw new PaymentError(
        502,
        '当前商户未完成实名认证，无法收款',
        'definitive',
        'payment.rejected',
      );
    });
    app.get('/__test/commerce-error', async () => {
      throw new CommerceError('product_not_found', '商品不存在');
    });
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

  it('renders a kernel-domain provider failure with its code and reason', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/payment-error' });
    expect(res.statusCode).toBe(502);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json() as { status: number; code: string; detail?: string };
    expect(body.status).toBe(502);
    expect(body.code).toBe('payment.rejected');
    expect(body.detail).toBe('当前商户未完成实名认证，无法收款');
  });

  it('renders a commerce-domain rejection with its mapped status', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/commerce-error' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { code: string; detail?: string };
    expect(body.code).toBe('commerce.product_not_found');
    expect(body.detail).toBe('商品不存在');
  });
});
