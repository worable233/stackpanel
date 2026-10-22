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
 * A stable `code` from our own proxy (`agentRoute.*`) is a top-level catalog key;
 * a problem `code` forwarded from the API (`agent.budget_exhausted`, …) lives
 * under the `error.*` namespace like every other API code. Both are tried before
 * falling back, so upstream prose only shows when we genuinely have no copy.
 */
export function agentErrorText(
  t: (key: string) => string,
  cause: unknown,
  fallback: string,
): string {
  if (cause instanceof AgentApiError && cause.code) {
    for (const key of [`error.${cause.code}`, cause.code]) {
      const localized = t(key);
      if (localized !== key) return localized;
    }
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
