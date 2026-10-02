import type { FieldError, ProblemDetails } from '@stackpanel/sdk';

/**
 * RFC 7807 / RFC 9457 problem-details helpers (ADR-0012).
 *
 * The API emits one error shape everywhere: `application/problem+json` with a
 * stable `code`. Historically responses were `{ error: string }` (Chinese
 * prose). The kernel normalises every error response in a single `onSend` hook:
 * a legacy `{ error }` body is promoted to `detail`. The compatibility window is
 * over — the legacy `error` member is no longer emitted (ADR-0012 §后果).
 */

/** Base URI for error types. Stable per code; resolves to docs eventually. */
const ERROR_TYPE_BASE = 'https://errors.stackpanel.dev';

const STATUS_TITLE: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const STATUS_CODE: Record<number, string> = {
  400: 'request.invalid',
  401: 'auth.unauthenticated',
  403: 'auth.forbidden',
  404: 'request.not_found',
  405: 'request.method_not_allowed',
  409: 'request.conflict',
  410: 'request.gone',
  413: 'request.payload_too_large',
  415: 'request.unsupported_media_type',
  422: 'validation.invalid',
  429: 'request.rate_limited',
  500: 'internal.unexpected',
  503: 'internal.unavailable',
};

/** Neutral English title for an HTTP status; falls back to the reason class. */
export function titleForStatus(status: number): string {
  return STATUS_TITLE[status] ?? (status >= 500 ? 'Server Error' : 'Request Error');
}

/** Default namespaced code for an HTTP status when the caller gives none. */
export function codeForStatus(status: number): string {
  return STATUS_CODE[status] ?? (status >= 500 ? 'internal.unexpected' : 'request.invalid');
}

/** Build a fully-formed problem-details object. */
export function buildProblem(input: {
  status: number;
  code?: string;
  title?: string;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: FieldError[];
}): ProblemDetails {
  const code = input.code && input.code.length > 0 ? input.code : codeForStatus(input.status);
  const problem: ProblemDetails = {
    type: `${ERROR_TYPE_BASE}/${code.replace(/\./g, '/')}`,
    title: input.title ?? titleForStatus(input.status),
    status: input.status,
    code,
  };
  if (input.detail) problem.detail = input.detail;
  if (input.instance) problem.instance = input.instance;
  if (input.requestId) problem.requestId = input.requestId;
  if (input.errors && input.errors.length > 0) problem.errors = input.errors;
  return problem;
}

/**
 * Normalise a legacy error body into problem details. A body already carrying a
 * `type` + `code` is returned unchanged. Otherwise the legacy `{ error }`
 * member is promoted to `detail` (the legacy `error` member is dropped).
 */
export function normalizeErrorBody(
  status: number,
  body: unknown,
  base: { instance?: string; requestId?: string } = {},
): ProblemDetails {
  const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const isProblem = typeof record.type === 'string' && typeof record.code === 'string';
  const detail =
    typeof record.detail === 'string'
      ? record.detail
      : typeof record.error === 'string'
        ? record.error
        : undefined;
  const code = typeof record.code === 'string' ? record.code : codeForStatus(status);
  return isProblem
    ? (record as unknown as ProblemDetails)
    : buildProblem({
        status,
        code,
        ...(detail ? { detail } : {}),
        ...(base.instance ? { instance: base.instance } : {}),
        ...(base.requestId ? { requestId: base.requestId } : {}),
        ...(Array.isArray(record.errors) ? { errors: record.errors as FieldError[] } : {}),
      });
}
