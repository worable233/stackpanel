import { PluginError } from '@stackpanel/sdk';

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
      __spType: 'error', message: error.message,
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
    return { __spType: 'buffer', value: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('circular RPC value');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => encodeWire(item, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeWire(item, seen)]));
  } finally { seen.delete(value); }
}

export function decodeWire(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (!Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    if (item.__spType === 'date' && typeof item.value === 'string') return new Date(item.value);
    if (item.__spType === 'bigint' && typeof item.value === 'string') return BigInt(item.value);
    if (item.__spType === 'buffer' && typeof item.value === 'string') return Buffer.from(item.value, 'base64');
    if (item.__spType === 'error' && typeof item.message === 'string') {
      const error = new Error(item.message) as Error & { code?: unknown; status?: unknown; details?: unknown };
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

export function wireError(error: unknown): { message: string; code?: string; status?: number; details?: unknown } {
  const candidate = error as { message?: unknown; code?: unknown; status?: unknown; details?: unknown };
  return {
    message: String(candidate?.message ?? error),
    ...(typeof candidate?.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate?.status === 'number' ? { status: candidate.status } : {}),
    ...(candidate?.details !== undefined ? { details: encodeWire(candidate.details) } : {}),
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
  details?: unknown;
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
  if (input.code === undefined || input.status === undefined) {
    const error = new Error(input.message) as Error & {
      code?: string;
      status?: number;
      details?: unknown;
    };
    if (input.code !== undefined) error.code = input.code;
    if (input.status !== undefined) error.status = input.status;
    if (details !== undefined) error.details = details;
    return error;
  }
  const error = new PluginError(input.code, input.status, input.message);
  // `PluginError` sets `message` to the code; keep the worker's human-readable
  // text so logs and the problem-details `detail` stay meaningful.
  error.message = input.message;
  const branded = error as PluginError & { statusCode?: number; details?: unknown };
  branded.statusCode = input.status;
  if (details !== undefined) branded.details = details;
  return error;
}
