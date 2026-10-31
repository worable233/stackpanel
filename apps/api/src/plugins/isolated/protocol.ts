import { PluginError, brandSdkErrorValue, sdkErrorClassName } from '@stackpanel/sdk';

export const RPC_PROTOCOL = 1 as const;
export const RPC_TIMEOUT_MS = 10_000;
export const RPC_MAX_BYTES = 1024 * 1024;
export const RPC_MAX_IN_FLIGHT = 64;
/** Max raw bytes per streamed request/response chunk (before base64). */
export const RAW_CHUNK_BYTES = 64 * 1024;
/** Max unacknowledged response bytes before `RawHttpReply.write` reports backpressure. */
export const RAW_WINDOW_BYTES = 1024 * 1024;
/**
 * Hard ceiling on bytes a single raw stream may hold in the worker's outbound
 * queue (beyond {@link RAW_WINDOW_BYTES}, which bounds bytes already handed to
 * IPC but not yet acknowledged). Without this the queue grew without bound when
 * the client read slower than the upstream produced (ADR-0022 P1).
 */
export const RAW_MAX_QUEUE_BYTES = 4 * 1024 * 1024;
/** Max concurrent raw streams per isolated worker. */
export const RPC_MAX_RAW_STREAMS = 256;

/** Convert values that JSON IPC cannot represent without silently changing them. */
export function encodeWire(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; status?: unknown; details?: unknown };
    return {
      __spType: 'error',
      message: error.message,
      ...(typeof error.name === 'string' ? { name: error.name } : {}),
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      ...(error.details !== undefined ? { details: encodeWire(error.details, seen) } : {}),
    };
  }
  if (typeof value === 'bigint') return { __spType: 'bigint', value: value.toString() };
  if (value instanceof Date) return { __spType: 'date', value: value.toISOString() };
  if (Buffer.isBuffer(value)) return { __spType: 'buffer', value: value.toString('base64') };
  // `Buffer` is a `Uint8Array`, but a plain `Uint8Array` (e.g. a storage proxy
  // chunk sliced out of a larger buffer) is not a `Buffer`. Without this branch
  // it would serialize as `{ "0": 1, "1": 2, ... }` and blow up the message size.
  if (value instanceof Uint8Array) {
    return {
      __spType: 'buffer',
      value: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
    };
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('circular RPC value');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => encodeWire(item, seen));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeWire(item, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

export function decodeWire(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (!Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    if (item.__spType === 'date' && typeof item.value === 'string') return new Date(item.value);
    if (item.__spType === 'bigint' && typeof item.value === 'string') return BigInt(item.value);
    if (item.__spType === 'buffer' && typeof item.value === 'string')
      return Buffer.from(item.value, 'base64');
    if (item.__spType === 'error' && typeof item.message === 'string') {
      const error = new Error(item.message) as Error & {
        code?: unknown;
        status?: unknown;
        details?: unknown;
      };
      if (typeof item.name === 'string') error.name = item.name;
      if (typeof item.code === 'string') error.code = item.code;
      if (typeof item.status === 'number') error.status = item.status;
      if (item.details !== undefined) error.details = decodeWire(item.details);
      return error;
    }
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, decodeWire(child)]));
  }
  return value.map(decodeWire);
}

export function wireError(error: unknown): {
  message: string;
  code?: string;
  status?: number;
  detail?: string;
  details?: unknown;
  sdkError?: string;
} {
  const candidate = error as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
    detail?: unknown;
    details?: unknown;
  };
  // The SDK error-class brand (`WalletError` et al.) lives on the prototype and
  // is non-enumerable, so it is lost the moment the error is serialized. Send
  // the class name explicitly: `isWalletError`/`isSdkErrorClass` on the host
  // depend on it, and without it a plugin's `catch (e) { if (isWalletError(e)) }`
  // silently takes the generic branch (e.g. referral treats an
  // `insufficient_balance` debit as a hard failure instead of recording 0).
  const sdkError = sdkErrorClassName(error);
  return {
    message: String(candidate?.message ?? error),
    ...(typeof candidate?.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate?.status === 'number' ? { status: candidate.status } : {}),
    // `detail` is the human-readable half of a plugin error; without it the
    // receiving side can only show the machine code.
    ...(typeof candidate?.detail === 'string' ? { detail: candidate.detail } : {}),
    ...(candidate?.details !== undefined ? { details: encodeWire(candidate.details) } : {}),
    ...(sdkError !== undefined ? { sdkError } : {}),
  };
}

/**
 * Parse a `tx.<group>.<operation>` capability into its parts, or `null` when
 * the capability is not a transactional call.
 *
 * `extensions` is deliberately excluded: `tx.extensions.create` has the same
 * `tx.<group>.<op>` shape, so a naive pattern matched it here and every
 * isolated plugin's transactional extension call died in the wallet/payments
 * branch with "未知事务操作：extensions.create". The dedicated extensions handler
 * further down resolves the model and dispatches those calls instead.
 *
 * Method names are camelCase (`settleHold`), hence the uppercase in group two.
 */
export function parseTransactionCapability(
  capability: string,
): { group: string; operation: string } | null {
  const match = /^tx\.(?!extensions\.)([a-z]+)\.([a-zA-Z]+)$/.exec(capability);
  if (!match) return null;
  return { group: match[1] ?? '', operation: match[2] ?? '' };
}

/** Structured error shape sent across the worker boundary. */
export interface WireError {
  message: string;
  code?: string;
  status?: number;
  /** Human-readable reason rendered in the problem document. */
  detail?: string;
  details?: unknown;
  /**
   * SDK error class name (`WalletError`, `CurrencyError`, …) the worker threw.
   * Restored on the host so `isWalletError`-style narrowing keeps working.
   */
  sdkError?: string;
}

/**
 * Rebuild a worker-thrown error on the host side.
 *
 * The worker runs in a separate process, so a plugin's `PluginError` arrives as
 * plain data. Re-wrapping it in a bare `Error` and copying `code`/`status` was
 * not enough: `isPluginError` matches on a brand that only lives on the SDK
 * class, so the kernel error boundary saw an unknown fault and demoted every
 * deterministic 4xx (403 "no access to this ticket", 404 "not found") to a
 * generic 500. Rebuilding a branded `PluginError` restores the contract.
 *
 * Errors missing either a code or a status stay plain `Error`s, so genuine
 * crashes are still reported as internal faults rather than client errors.
 */
export function reviveWireError(input: WireError): Error {
  const details = input.details !== undefined ? decodeWire(input.details) : undefined;
  // `sdkError` restores the SDK class brand that JSON cannot carry. Without it,
  // a plugin's `catch (e) { if (isWalletError(e)) … }` silently falls through to
  // the generic branch after crossing the worker boundary.
  const restoreBrand = (error: Error): Error => {
    if (input.sdkError !== undefined) brandSdkErrorValue(error, input.sdkError);
    return error;
  };
  // No `status`, or a 5xx, means the worker did not claim a deterministic client
  // error. Those stay plain `Error`s so `isPluginError` keeps returning false:
  // a kernel crash or an upstream 500 must surface as an internal fault, not be
  // dressed up as a deliberate refusal.
  if (input.status === undefined || input.status >= 500) {
    const error = new Error(input.message) as Error & {
      code?: string;
      status?: number;
      detail?: string;
      details?: unknown;
    };
    if (input.code !== undefined) error.code = input.code;
    // The status still has to travel — the kernel reads it to pick the problem
    // document — it just must not come with the `PluginError` brand, which is
    // what tells the boundary "the plugin deliberately refused this".
    if (input.status !== undefined) error.status = input.status;
    if (input.detail !== undefined) error.detail = input.detail;
    if (details !== undefined) error.details = details;
    return restoreBrand(error);
  }
  // A 4xx status without a code is a real case — a provider's local error class
  // may only carry `status`/`statusCode`. Requiring a code used to leave the
  // status on a plain `Error`, so the kernel re-rendered a deliberate 409 as a
  // generic 500 and the operator saw no reason at all. Fall back to a generic
  // code so the `PluginError` brand (and therefore the status) survives.
  //
  // `detail` is the human-readable half the kernel renders in the problem
  // document; without carrying it the operator only ever sees the machine code.
  const detail = input.detail ?? input.message;
  const error = new PluginError(input.code ?? 'plugin.error', input.status, detail);
  // `PluginError` sets `message` to the code; keep the worker's human-readable
  // text so logs and the problem-details `detail` stay meaningful.
  error.message = input.message;
  const branded = error as PluginError & { statusCode?: number; details?: unknown };
  branded.statusCode = input.status;
  if (details !== undefined) branded.details = details;
  return restoreBrand(error);
}
