'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { PluginActionDefinition } from '@stackpanel/sdk';
import { getAuthedApiClient } from './api';
import { apiErrorMessage } from './api-errors';
import { actionTargetsSchema } from './frontend-plugin-action-targets';
import { safeInternalPath } from './safe-path';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { listPluginFrontendCandidates } from './slots';
import { isNextRedirectError } from './next-navigation';
import { expiredSessionLoginPath, isExpiredSessionError } from './session-recovery';
import { actionSuccessUrl, formatActionSuccessMessage } from './frontend-plugin-action-feedback';
import { readPackageMessages, packageMessage } from '@/i18n/package-messages';

/** The only mutation bridge exposed to plugin frontend packages. */
export async function executePluginAction(
  pluginId: string,
  actionId: string,
  returnPath: string,
  formData: FormData,
): Promise<void> {
  const locale = await getLocale();
  const candidate = (await listPluginFrontendCandidates()).find((item) => item.id === pluginId);
  const action = candidate?.manifest.actions.find((item) => item.id === actionId);
  if (!candidate || !action) {
    return actionFailure(returnPath, actionId, translate(locale, 'action.pluginUnavailable'));
  }

  const api = await getAuthedApiClient();
  if (action.permission) {
    try {
      if (!(await api.checkPermission(action.permission)).allowed) {
        actionFailure(returnPath, actionId, translate(locale, 'action.pluginForbidden'));
      }
    } catch (error) {
      if (isNextRedirectError(error)) throw error;
      if (isExpiredSessionError(error)) return expiredSessionFailure(returnPath);
      return actionFailure(returnPath, actionId, translate(locale, 'action.pluginLoginRequired'));
    }
  }

  let destination: string | null = null;
  let result: unknown;
  try {
    const targets = await api.get(
      `/plugins/${encodeURIComponent(pluginId)}/action-targets`,
      actionTargetsSchema,
    );
    const target = targets.routes.find(
      (route) => route.method === action.method && route.path === action.path,
    );
    if (!target || (target.permission ?? undefined) !== (action.permission ?? undefined)) {
      return actionFailure(
        returnPath,
        actionId,
        translate(locale, 'action.pluginInvalidDeclaration'),
      );
    }
    const body = coerceActionInput(action, formData);
    const path = resolveActionPath(action.path, body);
    result =
      action.method === 'POST'
        ? await api.post(path, body, z.unknown())
        : action.method === 'PATCH'
          ? await api.patch(path, body, z.unknown())
          : await api.del(path, z.unknown());
    destination = action.redirect ? redirectDestination(action, result) : null;
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    if (isExpiredSessionError(error)) return expiredSessionFailure(returnPath);
    console.error(`[action:${actionId}] failed`, error);
    const message = await apiErrorMessage(error, translate(locale, 'action.pluginActionFailed'));
    return actionFailure(returnPath, actionId, message);
  }
  await api
    .recordFrontendAudit('frontend.action.execute', pluginId, actionId, { method: action.method })
    .catch(() => undefined);
  revalidatePath(new URL(returnPath, 'http://stackpanel.local').pathname);
  if (action.successFeedback) {
    // `messageKey` resolves through the package's own catalog (ADR-0016 §5) so
    // a localized package gets a localized receipt; the literal `message` stays
    // the fallback for locales the package does not ship.
    const { messages } = readPackageMessages(candidate.id, candidate.manifest.messages);
    const localized = packageMessage(messages, locale, action.successFeedback.messageKey, [
      DEFAULT_LOCALE,
    ]);
    const message = localized ?? action.successFeedback.message;
    if (message) {
      actionSuccess(
        returnPath,
        actionId,
        formatActionSuccessMessage({ ...action.successFeedback, message }, result),
      );
    }
  }
  // Only redirect when the action declares an explicit destination. A bare
  // `redirect(returnPath)` on success would reject the server-action promise
  // (Next's reducer rejects on redirect), which plugin frontends that `await`
  // the action mistake for a failure — even though the mutation persisted.
  // `revalidatePath` above already refreshes the current route's data.
  // See INTERFACES.md §3.4「前端 action 执行语义」.
  if (destination) redirect(destination);
}

/** Resolve declared `:id` path parameters from already validated form fields. */
function resolveActionPath(
  path: string,
  body: Record<string, string | number | boolean | string[]>,
): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const value = body[key];
    if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing ${key}`);
    return encodeURIComponent(value);
  });
}

function coerceActionInput(
  action: PluginActionDefinition,
  formData: FormData,
): Record<string, string | number | boolean | string[]> {
  const body: Record<string, string | number | boolean | string[]> = {};
  for (const field of action.input ?? []) {
    if (field.type === 'ids') {
      const values = formData.getAll(field.name).map(String);
      body[field.name] = coerceIdList(field, values);
      continue;
    }
    const raw = formData.get(field.name);
    const value = raw === null || raw === '' ? field.default : raw;
    if (value === undefined || value === null || (value === '' && field.default !== '')) {
      if (field.required) throw new Error(`Missing ${field.name}`);
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`Invalid ${field.name}`);
    }
    body[field.name] = coerceField(field, value);
  }
  return body;
}

function coerceIdList(
  field: NonNullable<PluginActionDefinition['input']>[number],
  values: string[],
): string[] {
  if (values.length === 0) {
    if (field.required) throw new Error(`Missing ${field.name}`);
    return [];
  }
  const clamped = values.slice(0, field.max ?? 50).filter((value) => value.length > 0);
  if (field.required && clamped.length === 0) throw new Error(`Missing ${field.name}`);
  for (const value of clamped) {
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      throw new Error(`Invalid ${field.name}`);
    }
  }
  return clamped;
}

function coerceField(
  field: NonNullable<PluginActionDefinition['input']>[number],
  value: string | number | boolean,
): string | number | boolean {
  if (field.type === 'string') {
    if (typeof value !== 'string') throw new Error(`Invalid ${field.name}`);
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      throw new Error(`Invalid ${field.name}`);
    }
    return value;
  }
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1' || value === 'on') return true;
    if (value === 'false' || value === '0' || value === 'off') return false;
    throw new Error(`Invalid ${field.name}`);
  }
  if (field.type === 'money') {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) {
      throw new Error(`Invalid ${field.name}`);
    }
    const [units, fraction = ''] = value.split('.');
    const parsed = Number(units) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${field.name}`);
    if (
      (field.min !== undefined && parsed < field.min) ||
      (field.max !== undefined && parsed > field.max)
    ) {
      throw new Error(`Invalid ${field.name}`);
    }
    return parsed;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || (field.type === 'integer' && !Number.isInteger(parsed))) {
    throw new Error(`Invalid ${field.name}`);
  }
  if (
    (field.min !== undefined && parsed < field.min) ||
    (field.max !== undefined && parsed > field.max)
  ) {
    throw new Error(`Invalid ${field.name}`);
  }
  return parsed;
}

function redirectDestination(action: PluginActionDefinition, response: unknown): string | null {
  const config = action.redirect;
  if (!config) return null;
  const value = config.responsePath
    .split('.')
    .reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), response);
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid redirect response');
  if (!config.external) {
    const safe = safeInternalPath(value);
    if (!safe) throw new Error('Invalid internal redirect');
    return safe;
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Invalid external redirect');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Insecure external redirect');
  }
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function actionFailure(returnPath: string, actionId: string, message: string): never {
  const url = new URL(returnPath, 'http://stackpanel.local');
  url.searchParams.set('action', actionId);
  url.searchParams.set('error', message);
  redirect(`${url.pathname}${url.search}${url.hash}`);
}

/** Route an opted-in, manifest-declared success notice through the shared toaster. */
function actionSuccess(returnPath: string, actionId: string, message: string): never {
  redirect(actionSuccessUrl(returnPath, actionId, message));
}

/** Drop a stale opaque token before routing the operator through a fresh login. */
async function expiredSessionFailure(returnPath: string): Promise<never> {
  const store = await cookies();
  store.delete(process.env.SESSION_COOKIE_NAME ?? 'sp_session');
  redirect(expiredSessionLoginPath(returnPath));
}
