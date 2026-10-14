/**
 * Streaming frame shapes for `kind: 'raw'` routes under isolated execution.
 *
 * Isolated mode speaks one-shot JSON IPC (`invoke` → single `result`), which
 * cannot express a raw route's unparsed request stream + long-lived response
 * stream. Rather than change the `fork` serialization mode (which would ripple
 * through `encodeWire`/`decodeWire` and the per-message size guard), chunks
 * travel as explicit base64 strings inside the existing JSON channel. Both the
 * host and the worker import these types so the two sides cannot drift.
 *
 * See `docs/architecture/INTERFACES.md` §3.3e for the frozen contract.
 */

/** Metadata for a raw invocation (no body; the body streams in separately). */
export interface RawInvokeRequest {
  method: string;
  url: string;
  params: Record<string, string>;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  user?: { id: string; role: string; email?: string };
  sessionToken?: string;
}

/** host → worker: start a raw invocation for `id`. */
export interface RawInvokeFrame {
  protocol: 1;
  pluginId: string;
  type: 'raw-invoke';
  id: string;
  /** Route method + path pattern used to locate the handler in the worker. */
  method: string;
  route: string;
  request: RawInvokeRequest;
}

/** host → worker: one request-body chunk (or EOF when `eof`). */
export interface RawBodyFrame {
  protocol: 1;
  pluginId: string;
  type: 'raw-body';
  id: string;
  /** base64-encoded bytes; absent when `eof`. */
  data?: string;
  /** true = no more request body will follow. */
  eof?: boolean;
}

/** host → worker: the request body stream failed upstream (client abort etc.). */
export interface RawBodyErrorFrame {
  protocol: 1;
  pluginId: string;
  type: 'raw-body-error';
  id: string;
  message: string;
}

/** host → worker: the client disconnected (or the socket timed out). */
export interface RawAbortFrame {
  protocol: 1;
  pluginId: string;
  type: 'raw-abort';
  id: string;
  reason: string;
}

/** worker → host: the plugin decided status + headers; flush before first chunk. */
export interface RawHeadFrame {
  protocol: 1;
  pluginId: string;
  type: 'raw-head';
  id: string;
  status: number;
  headers: Array<[string, string | string[]]>;
}

/** worker → host: one response-body chunk. */
export interface RawChunkFrame {
  protocol: 1;
  pluginId: string;
  type: 'raw-chunk';
  id: string;
  /** base64-encoded bytes. */
  data: string;
}

/** worker → host: the response ended (successfully or as the final flush). */
export interface RawEndFrame {
  protocol: 1;
  pluginId: string;
  type: 'raw-end';
  id: string;
}

/** worker → host: the handler failed before the response was fully written. */
export interface RawErrorFrame {
  protocol: 1;
  pluginId: string;
  type: 'raw-error';
  id: string;
  error: { message: string; code?: string; status?: number };
}

/** worker → host: pull the next request-body chunk (request-side backpressure). */
export interface RawPullFrame {
  protocol: 1;
  pluginId: string;
  type: 'raw-pull';
  id: string;
}

/**
 * host → worker: acknowledge `bytes` of response body flushed to the socket, so
 * the worker's outbound window reopens (response-side backpressure).
 */
export interface RawAckFrame {
  protocol: 1;
  pluginId: string;
  type: 'raw-ack';
  id: string;
  bytes: number;
}

export type RawHostFrame =
  | RawInvokeFrame
  | RawBodyFrame
  | RawBodyErrorFrame
  | RawAbortFrame
  | RawAckFrame;
export type RawWorkerFrame =
  | RawHeadFrame
  | RawChunkFrame
  | RawEndFrame
  | RawErrorFrame
  | RawPullFrame;
