import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/client.js';
import { ApiError } from '../src/errors.js';

const baseUrl = 'http://api.test';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ApiClient', () => {
  it('returns validated payload on success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        okResponse({ status: 'ok', uptime: 1.5, timestamp: '2026-08-01T00:00:00Z' }),
      );
    const client = new ApiClient({ baseUrl, fetchImpl });
    const health = await client.getHealth();
    expect(health.status).toBe('ok');
    expect(health.uptime).toBe(1.5);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${baseUrl}/health`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('throws ApiError with status on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":"boom"}', { status: 500 }));
    const client = new ApiClient({ baseUrl, fetchImpl });
    const err = await client.getHealth().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 500 });
  });

  it('parses RFC 7807 problem details into ApiError code/requestId/errors', async () => {
    const problem = {
      type: 'https://errors.stackpanel.dev/validation/invalid',
      title: 'Unprocessable Entity',
      status: 422,
      detail: '请求参数无效',
      instance: '/me/api-tokens',
      code: 'validation.invalid',
      requestId: 'req_123',
      errors: [{ field: 'name', code: 'validation.required', message: 'Required' }],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(problem), {
          status: 422,
          headers: { 'content-type': 'application/problem+json' },
        }),
      );
    const client = new ApiClient({ baseUrl, fetchImpl });
    const err = await client.getHealth().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'validation.invalid', requestId: 'req_123' });
    expect((err as ApiError).errors?.[0]).toMatchObject({ field: 'name' });
  });

  it('throws ApiError when payload fails zod validation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ unexpected: true }));
    const client = new ApiClient({ baseUrl, fetchImpl });
    await expect(client.getHealth()).rejects.toBeInstanceOf(ApiError);
  });

  it('throws ApiError with code timeout when request is aborted', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          const error = new DOMException('aborted', 'AbortError');
          reject(error);
        };
        init?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    });
    const client = new ApiClient({ baseUrl, timeoutMs: 20, fetchImpl });
    await expect(client.getHealth()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('throws ApiError on network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = new ApiClient({ baseUrl, fetchImpl });
    await expect(client.getHealth()).rejects.toMatchObject({ code: 'network' });
  });

  it('sends a Bearer token and JSON body on POST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        token: 't',
        user: {
          id: 'u',
          email: 'a@b.c',
          role: 'USER',
          status: 'ACTIVE',
          createdAt: '',
          updatedAt: '',
          lastLoginAt: null,
        },
      }),
    );
    const client = new ApiClient({ baseUrl, token: 'secret-token', fetchImpl });
    await client.login('a@b.c', 'password');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret-token' });
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@b.c', password: 'password' });
  });
});
