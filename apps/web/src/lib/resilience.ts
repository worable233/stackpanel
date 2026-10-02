/**
 * Web→API client resilience (ADR-0015 §4).
 *
 * A drop-in {@link fetch} wrapper installed under the SDK {@link ApiClient}, so
 * every existing BFF call (reads and writes) gains timeout/retry/circuit
 * behaviour without touching a single call site.
 *
 * Layering:
 *   - **Timeout** is enforced here **per attempt** via a fresh `AbortController`,
 *     so a timed-out attempt is still retryable (the SDK's single controller
 *     would stay aborted across attempts). Aborts surface as a retryable
 *     `AbortError`; the wrapper only imposes a timeout when `timeoutMs > 0`.
 *   - **Retry** is transport-level and only for *idempotent* methods
 *     (`GET/HEAD/OPTIONS/PUT/DELETE`) — a `POST`/`PATCH` is never re-sent
 *     blindly, so a transient 502 cannot double-charge or double-create. Retries
 *     cover network failures, aborts/timeouts, `408`, `429` and `5xx`, with
 *     exponential backoff + jitter.
 *   - **Circuit breaker** trips after N consecutive failures and then fails
 *     fast (`circuit_open`) for a cooldown, probing once in half-open before
 *     closing again. This is what stops one slow upstream from cascading into
 *     the web tier.
 *
 * Everything is injectable (clock, sleep, randomness, fetch) so behaviour is
 * deterministic under test; production uses the real globals.
 */
import { ApiError } from '@stackpanel/sdk';

/** Bounded retry policy. `attempts` counts the first try. */
export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Jitter fraction (0..1) applied symmetrically to the backoff delay. */
  jitter: number;
}

/** Circuit-breaker thresholds. */
export interface CircuitPolicy {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** Consecutive half-open successes that close it again. */
  successThreshold: number;
  /** How long the circuit stays open before a single probe is allowed. */
  cooldownMs: number;
}

export interface ResilienceOptions {
  /** Override the retry policy (partial merge over the defaults). */
  retry?: Partial<RetryPolicy>;
  /** Override the circuit policy (partial merge over the defaults). */
  circuit?: Partial<CircuitPolicy>;
  /** Per-attempt timeout enforced here (0 disables); defaults to no wrapper timeout. */
  timeoutMs?: number;
  /** Transport under test; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (tests pass a no-op); defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness in `[0, 1)`; defaults to `Math.random`. */
  random?: () => number;
  /** Injectable clock (ms); defaults to `Date.now`. */
  now?: () => number;
  /** Observability hook fired before each backoff wait. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: unknown }) => void;
}

const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  jitter: 0.25,
};

const DEFAULT_CIRCUIT: CircuitPolicy = {
  failureThreshold: 5,
  successThreshold: 1,
  cooldownMs: 10_000,
};

/** Methods safe to re-send: no additional side effect on a second attempt. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** HTTP statuses worth a retry: transient timeout/quota/upstream failures. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** HTTP statuses that count against the circuit (upstream failure, not client error). */
function isCircuitFailureStatus(status: number): boolean {
  return status >= 500;
}

/** Network/abort failures are retryable; application errors are not. */
function isRetryableError(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === 'timeout' || error.code === 'network';
  if (error instanceof DOMException) return error.name === 'AbortError';
  // Node/undici surface transport failures as a bare `TypeError: fetch failed`.
  return error instanceof TypeError;
}

/** A shared failure budget; state lives in one instance per API base. */
export class CircuitBreaker {
  #phase: 'closed' | 'open' | 'half-open' = 'closed';
  #failures = 0;
  #successes = 0;
  #openedAt = 0;

  constructor(
    private readonly policy: CircuitPolicy,
    private readonly now: () => number,
  ) {}

  get phase(): 'closed' | 'open' | 'half-open' {
    return this.#phase;
  }

  /** Whether a call may proceed; transitions open→half-open once cooled down. */
  tryAcquire(): boolean {
    if (this.#phase === 'open') {
      if (this.now() - this.#openedAt >= this.policy.cooldownMs) {
        this.#phase = 'half-open';
        this.#successes = 0;
        return true;
      }
      return false;
    }
    return true;
  }

  onSuccess(): void {
    if (this.#phase === 'half-open') {
      this.#successes += 1;
      if (this.#successes >= this.policy.successThreshold) this.#close();
      return;
    }
    this.#failures = 0;
  }

  onFailure(): void {
    if (this.#phase === 'half-open') {
      this.#reopen();
      return;
    }
    this.#failures += 1;
    if (this.#failures >= this.policy.failureThreshold) this.#reopen();
  }

  #open(): void {
    this.#phase = 'open';
    this.#openedAt = this.now();
  }

  #reopen(): void {
    this.#open();
  }

  #close(): void {
    this.#phase = 'closed';
    this.#failures = 0;
    this.#successes = 0;
    this.#openedAt = 0;
  }
}

/** Read the effective method of a fetch call (init wins over a Request object). */
function readMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === 'object' && !(input instanceof URL) && 'method' in input) {
    return (input as Request).method.toUpperCase();
  }
  return 'GET';
}

/** Exponential backoff with symmetric jitter, clamped to the max delay. */
function backoffDelay(policy: RetryPolicy, attempt: number, random: () => number): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const factor = 1 + (random() * 2 - 1) * policy.jitter;
  return Math.max(0, Math.round(exponential * factor));
}

/** Combine two abort signals without relying solely on `AbortSignal.any`. */
function combineSignals(a: AbortSignal | null | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') return any([a, b]);
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (a.aborted || b.aborted) abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return controller.signal;
}

/**
 * Build a resilient `fetch`. Callers install it as `ApiClient({ fetchImpl })`;
 * the wrapper is stateful (it owns the circuit) so build **one per API base** and
 * reuse it across requests.
 *
 * When `timeoutMs` is set the wrapper enforces it **per attempt** (a fresh
 * `AbortController` each try), so a timed-out attempt can still be retried —
 * unlike the SDK's single controller, which stays aborted. Callers that set a
 * timeout here should give `ApiClient` a generous aggregate budget instead.
 */
export function createResilientFetch(options: ResilienceOptions = {}): typeof fetch {
  const retry: RetryPolicy = { ...DEFAULT_RETRY, ...options.retry };
  const circuitPolicy: CircuitPolicy = { ...DEFAULT_CIRCUIT, ...options.circuit };
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 0;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const breaker = new CircuitBreaker(circuitPolicy, now);

  /** One transport attempt with its own timeout controller. */
  async function fetchAttempt(
    request: RequestInfo | URL,
    requestInit: RequestInit | undefined,
  ): Promise<Response> {
    if (timeoutMs <= 0) return doFetch(request, requestInit);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const signal = combineSignals(requestInit?.signal ?? null, controller.signal);
      return await doFetch(request, { ...requestInit, signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Run one logical request (idempotent: retry; otherwise single attempt). */
  async function run(
    request: RequestInfo | URL,
    requestInit: RequestInit | undefined,
    idempotent: boolean,
  ): Promise<Response> {
    const maxAttempts = idempotent ? retry.attempts : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetchAttempt(request, requestInit);
        if (isRetryableStatus(response.status) && attempt < maxAttempts) {
          const delayMs = backoffDelay(retry, attempt, random);
          options.onRetry?.({ attempt, delayMs, reason: response.status });
          await sleep(delayMs);
          continue;
        }
        if (isCircuitFailureStatus(response.status)) breaker.onFailure();
        else breaker.onSuccess();
        return response;
      } catch (error) {
        lastError = error;
        if (isRetryableError(error) && attempt < maxAttempts) {
          const delayMs = backoffDelay(retry, attempt, random);
          options.onRetry?.({ attempt, delayMs, reason: error });
          await sleep(delayMs);
          continue;
        }
        breaker.onFailure();
        throw error;
      }
    }
    throw lastError;
  }

  const resilient = async (
    request: RequestInfo | URL,
    requestInit?: RequestInit,
  ): Promise<Response> => {
    const idempotent = IDEMPOTENT_METHODS.has(readMethod(request, requestInit));
    if (!breaker.tryAcquire()) {
      throw new ApiError('上游接口连续失败，已熔断以保护本站', {
        status: 0,
        code: 'circuit_open',
      });
    }
    return run(request, requestInit, idempotent);
  };

  return resilient as typeof fetch;
}

/** Env-driven resilience configuration (ADR-0015 §4; default on). */
export interface ResilienceConfig {
  enabled: boolean;
  /** Per-attempt timeout enforced by the wrapper (0 disables). */
  timeoutMs: number;
  retry: RetryPolicy;
  circuit: CircuitPolicy;
}

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readFloat(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Resolve the effective resilience configuration from the environment. Defaults
 * are production-safe (on, 10s timeout, 3 attempts, breaker at 5 failures); an
 * operator can disable it with `API_RESILIENCE_ENABLED=false`.
 */
export function parseResilienceConfig(
  env: Record<string, string | undefined> = process.env,
): ResilienceConfig {
  return {
    enabled: env.API_RESILIENCE_ENABLED !== 'false',
    timeoutMs: readInt(env.API_TIMEOUT_MS, 10_000),
    retry: {
      attempts: readInt(env.API_RETRY_ATTEMPTS, DEFAULT_RETRY.attempts),
      baseDelayMs: readInt(env.API_RETRY_BASE_DELAY_MS, DEFAULT_RETRY.baseDelayMs),
      maxDelayMs: readInt(env.API_RETRY_MAX_DELAY_MS, DEFAULT_RETRY.maxDelayMs),
      jitter: readFloat(env.API_RETRY_JITTER, DEFAULT_RETRY.jitter),
    },
    circuit: {
      failureThreshold: readInt(
        env.API_CIRCUIT_FAILURE_THRESHOLD,
        DEFAULT_CIRCUIT.failureThreshold,
      ),
      successThreshold: readInt(env.API_CIRCUIT_SUCCESS_THRESHOLD, DEFAULT_CIRCUIT.successThreshold),
      cooldownMs: readInt(env.API_CIRCUIT_COOLDOWN_MS, DEFAULT_CIRCUIT.cooldownMs),
    },
  };
}
