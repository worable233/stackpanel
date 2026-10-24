/**
 * Next implements redirect() by throwing a control-flow error. Server-action
 * error handlers must let it propagate instead of presenting its digest.
 */
export function isNextRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof error.digest === 'string' &&
    error.digest.startsWith('NEXT_REDIRECT;')
  );
}
