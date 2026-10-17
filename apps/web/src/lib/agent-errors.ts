/**
 * Agent BFF failure model (ADR-0016 §2).
 *
 * The Agent proxy answers with a stable `code` (`agentRoute.*`) rather than a
 * prose `detail`, so the interface — not the API — owns the wording. These
 * helpers are the single place that maps a failed Agent request to display copy.
 */

/** A failed Agent BFF request carrying the proxy's stable code, when present. */
export class AgentApiError extends Error {
  readonly code: string | undefined;

  constructor(code: string | undefined, message: string) {
    super(message);
    this.name = 'AgentApiError';
    this.code = code;
  }
}

/**
 * Resolve an Agent failure to display text.
 *
 * A stable `code` from our own proxy is translated from the kernel catalog;
 * anything else (upstream prose) passes through, and an unknown failure falls
 * back to the caller's localized message.
 */
export function agentErrorText(
  t: (key: string) => string,
  cause: unknown,
  fallback: string,
): string {
  if (cause instanceof AgentApiError && cause.code) {
    const localized = t(cause.code);
    if (localized !== cause.code) return localized;
  }
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** Build a failure from a non-2xx Agent BFF response body. */
export function agentErrorFromBody(body: unknown): AgentApiError {
  const record = (body ?? {}) as { code?: unknown; detail?: unknown; error?: unknown };
  return new AgentApiError(
    typeof record.code === 'string' ? record.code : undefined,
    typeof record.detail === 'string'
      ? record.detail
      : typeof record.error === 'string'
        ? record.error
        : '',
  );
}
