/** Handle both the host proxy and RFC problem response formats. */
export function approvalErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const body = value as Record<string, unknown>;
  const nested = body.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>).message : undefined;
  for (const message of [body.detail, body.message, typeof body.error === 'string' ? body.error : nested]) {
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}
