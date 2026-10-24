import { formatMessage } from '@/i18n/core';

interface SuccessFeedback {
  message: string;
  params?: Record<string, string>;
}

/** Build an in-app success receipt consumed by the shared action toaster. */
export function actionSuccessUrl(returnPath: string, actionId: string, message: string): string {
  const url = new URL(returnPath, 'http://stackpanel.local');
  url.searchParams.set('action', actionId);
  url.searchParams.set('success', message);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Interpolate only declared finite numeric response fields into a success message. */
export function formatActionSuccessMessage(feedback: SuccessFeedback, response: unknown): string {
  const params: Record<string, number> = {};
  for (const [name, responsePath] of Object.entries(feedback.params ?? {})) {
    const value = responsePath
      .split('.')
      .reduce<unknown>(
        (current, key) =>
          typeof current === 'object' && current !== null
            ? (current as Record<string, unknown>)[key]
            : undefined,
        response,
      );
    if (typeof value === 'number' && Number.isFinite(value)) params[name] = value;
  }
  return formatMessage(feedback.message, params);
}
