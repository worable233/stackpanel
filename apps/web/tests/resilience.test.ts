import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@stackpanel/sdk';
import { createResilientFetch, parseResilienceConfig } from '@/lib/resilience';

/** A fetch stub returning the given statuses in order (last one repeats). */
function sequence(...statuses: number[]): { impl: typeof fetch; calls: number } {
  const state = { calls: 0 };
  const impl = vi.fn(async () => {
    const status = statuses[Math.min(state.calls, statuses.length - 1)] ?? 500;
    state.calls += 1;
    return new Response('{}', { status });
  }) as unknown as typeof fetch;
  return {
    impl,
    get calls() {
      return state.calls;
    },
  };
}

/** Deterministic harness: no real waiting, no jitter, controllable clock. */
function harness() {
  let now = 1_000;
  const slept: number[] = [];
  return {
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    random: () => 0.5,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    slept,
  };
}

describe('resilient fetch: retry', () => {
  it('passes a successful response through without retrying', async () => {
    const seq = sequence(200);
    const client = createResilientFetch({ fetchImpl: seq.impl });
    const res = await client('http://api.test/health', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(seq.calls).toBe(1);
  });

  it('retries an idempotent GET on 5xx and eventually succeeds', async () => {
    const seq = sequence(503, 503, 200);
    const h = harness();
    const retries: number[] = [];
    const client = createResilientFetch({
      fetchImpl: seq.impl,
      sleep: h.sleep,
      random: h.random,
      onRetry: (info) => retries.push(info.attempt),
    });
    const res = await client('http://api.test/health', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(seq.calls).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it('never retries a non-idempotent POST', async () => {
    const seq = sequence(503, 200);
    const client = createResilientFetch({ fetchImpl: seq.impl });
    const res = await client('http://api.test/login', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(seq.calls).toBe(1);
  });

  it('enforces a per-attempt timeout so a timed-out attempt can be retried', async () => {
    let calls = 0;
    const impl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        // First attempt hangs until its own abort fires.
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const h = harness();
    const client = createResilientFetch({
      fetchImpl: impl,
      timeoutMs: 5,
      retry: { attempts: 2 },
      sleep: h.sleep,
      random: h.random,
    });
    const res = await client('http://api.test/health', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('retries GET on a network failure then throws the last error', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const h = harness();
    const client = createResilientFetch({
      fetchImpl: impl,
      retry: { attempts: 2 },
      sleep: h.sleep,
      random: h.random,
    });
    await expect(client('http://api.test/health', { method: 'GET' })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(impl).toHaveBeenCalledTimes(2);
    expect(h.slept).toHaveLength(1);
  });

  it('does not retry a 4xx client error on GET', async () => {
    const seq = sequence(404, 200);
    const client = createResilientFetch({ fetchImpl: seq.impl });
    const res = await client('http://api.test/health', { method: 'GET' });
    expect(res.status).toBe(404);
    expect(seq.calls).toBe(1);
  });

  it('does not retry a timeout surfacing as API error is left to the caller', async () => {
    // A transport-level abort (DOMException) is retryable; the final attempt throws.
    const impl = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const h = harness();
    const client = createResilientFetch({
      fetchImpl: impl,
      retry: { attempts: 3 },
      sleep: h.sleep,
      random: h.random,
    });
    await expect(client('http://api.test/health', { method: 'GET' })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(impl).toHaveBeenCalledTimes(3);
  });
});

describe('resilient fetch: circuit breaker', () => {
  it('opens after the failure threshold and fails fast with circuit_open', async () => {
    const seq = sequence(500);
    const h = harness();
    const client = createResilientFetch({
      fetchImpl: seq.impl,
      retry: { attempts: 1 },
      circuit: { failureThreshold: 3, cooldownMs: 5_000 },
      sleep: h.sleep,
      random: h.random,
      now: h.now,
    });
    for (let i = 0; i < 3; i += 1) {
      await client('http://api.test/health', { method: 'GET' });
    }
    expect(seq.calls).toBe(3);

    const error = await client('http://api.test/health', { method: 'GET' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'circuit_open', status: 0 });
    // The upstream is not touched while the circuit is open.
    expect(seq.calls).toBe(3);
  });

  it('half-opens after cooldown and closes again after a successful probe', async () => {
    let open = true;
    let calls = 0;
    const impl = vi.fn(async () => {
      calls += 1;
      return new Response('{}', { status: open ? 500 : 200 });
    }) as unknown as typeof fetch;
    const h = harness();
    const client = createResilientFetch({
      fetchImpl: impl,
      retry: { attempts: 1 },
      circuit: { failureThreshold: 1, successThreshold: 1, cooldownMs: 1_000 },
      sleep: h.sleep,
      random: h.random,
      now: h.now,
    });

    // Trip the circuit.
    await client('http://api.test/health', { method: 'GET' });
    expect(calls).toBe(1);

    // Still too early: fail fast.
    await expect(client('http://api.test/health', { method: 'GET' })).rejects.toMatchObject({
      code: 'circuit_open',
    });
    expect(calls).toBe(1);

    // After the cooldown, one probe is allowed through; make it succeed.
    h.advance(1_000);
    open = false;
    const res = await client('http://api.test/health', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);

    // Circuit is closed again: normal traffic flows.
    await client('http://api.test/health', { method: 'GET' });
    expect(calls).toBe(3);
  });

  it('re-opens when the half-open probe fails', async () => {
    const seq = sequence(500);
    const h = harness();
    const client = createResilientFetch({
      fetchImpl: seq.impl,
      retry: { attempts: 1 },
      circuit: { failureThreshold: 1, cooldownMs: 1_000 },
      sleep: h.sleep,
      random: h.random,
      now: h.now,
    });
    await client('http://api.test/health', { method: 'GET' });
    h.advance(1_000);
    await client('http://api.test/health', { method: 'GET' });
    expect(seq.calls).toBe(2);
    // Immediately open again.
    await expect(client('http://api.test/health', { method: 'GET' })).rejects.toMatchObject({
      code: 'circuit_open',
    });
    expect(seq.calls).toBe(2);
  });

  it('counts non-idempotent write failures toward the circuit', async () => {
    const seq = sequence(500);
    const h = harness();
    const client = createResilientFetch({
      fetchImpl: seq.impl,
      circuit: { failureThreshold: 2, cooldownMs: 1_000 },
      sleep: h.sleep,
      random: h.random,
      now: h.now,
    });
    await client('http://api.test/login', { method: 'POST' });
    await client('http://api.test/login', { method: 'POST' });
    expect(seq.calls).toBe(2);
    await expect(client('http://api.test/login', { method: 'POST' })).rejects.toMatchObject({
      code: 'circuit_open',
    });
    expect(seq.calls).toBe(2);
  });
});

describe('resilience config', () => {
  it('is on by default with production-safe values', () => {
    const config = parseResilienceConfig({});
    expect(config.enabled).toBe(true);
    expect(config.timeoutMs).toBe(10_000);
    expect(config.retry.attempts).toBe(3);
    expect(config.circuit.failureThreshold).toBe(5);
  });

  it('reads operator overrides and can be disabled', () => {
    const config = parseResilienceConfig({
      API_RESILIENCE_ENABLED: 'false',
      API_TIMEOUT_MS: '2500',
      API_RETRY_ATTEMPTS: '5',
      API_CIRCUIT_FAILURE_THRESHOLD: '9',
    });
    expect(config.enabled).toBe(false);
    expect(config.timeoutMs).toBe(2_500);
    expect(config.retry.attempts).toBe(5);
    expect(config.circuit.failureThreshold).toBe(9);
  });

  it('ignores malformed values and keeps the defaults', () => {
    const config = parseResilienceConfig({
      API_TIMEOUT_MS: 'not-a-number',
      API_RETRY_ATTEMPTS: '-3',
    });
    expect(config.timeoutMs).toBe(10_000);
    expect(config.retry.attempts).toBe(3);
  });
});
