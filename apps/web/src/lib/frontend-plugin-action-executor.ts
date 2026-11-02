'use server';

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { clearSessionCookie } from './session-cookie.server';
import { redirect } from 'next/navigation';
import { ApiError } from '@stackpanel/sdk';
import type { PluginActionDefinition, PluginActionResult } from '@stackpanel/sdk';
import { getAuthedApiClient } from './api';
import { apiErrorMessageFor } from './api-errors';
import { actionTargetsSchema } from './frontend-plugin-action-targets';
import { safeInternalPath } from './safe-path';
import { getLocale } from '@/i18n/locale';
import { translate } from '@/i18n/core';
import { DEFAULT_LOCALE, type Locale } from '@/i18n/config';
import { listPluginFrontendCandidates } from './slots';
import { isNextRedirectError } from './next-navigation';
import { expiredSessionLoginPath, isExpiredSessionError } from './session-recovery';
import { formatActionSuccessMessage } from './frontend-plugin-action-feedback';
import { readPackageMessages, packageMessage } from '@/i18n/package-messages';

/**
 * The only mutation bridge exposed to plugin frontend packages.
 *
 * Resolves `{ ok, message?, error? }` for **domain** outcomes so the package can
 * render the receipt or the precise reason inline. Only real navigation
 * (`action.redirect`, expired session) rejects — see
 * `docs/design/feedback-ux-handoff.md` §4「action 返回语义」.
 */
export async function executePluginAction(
  pluginId: string,
  actionId: string,
  returnPath: string,
  formData: FormData,
): Promise<PluginActionResult> {
  const locale = await getLocale();
  const candidate = (await listPluginFrontendCandidates()).find((item) => item.id === pluginId);
  const action = candidate?.manifest.actions.find((item) => item.id === actionId);
  if (!candidate || !action) {
    return actionFailure(translate(locale, 'action.pluginUnavailable'));
  }

  const api = await getAuthedApiClient();
  if (action.permission) {
    try {
      if (!(await api.checkPermission(action.permission)).allowed) {
        return actionFailure(translate(locale, 'action.pluginForbidden'));
      }
    } catch (error) {
      if (isNextRedirectError(error)) throw error;
      if (isExpiredSessionError(error)) return expiredSessionFailure(returnPath);
      return actionFailure(translate(locale, 'action.pluginLoginRequired'));
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
      return actionFailure(translate(locale, 'action.pluginInvalidDeclaration'));
    }
    const body = coerceActionInput(action, formData);
    const path = resolveActionPath(action.path, body);
    // 写操作自动带上幂等键（C-2）：同一表单（同一动作 + 同一 body）在重试窗口内
    // 命中同一个键，插件侧可以只执行一次。此前 `Idempotency-Key` 只有 openApi
    // 路由与 Agent 在用，插件 action 完全不发，于是“双击保存 → 两条同名记录”
    // 只能由每个插件各自打补丁。
    const idempotency = action.method === 'POST' ? actionIdempotencyKey(action, body) : null;
    result =
      action.method === 'POST'
        ? await api.post(path, body, z.unknown(), idempotency ?? undefined)
          : action.method === 'PATCH'
          ? await api.patch(path, body, z.unknown())
          : await api.del(path, z.unknown());
    destination = action.redirect ? redirectDestination(action, result) : null;
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    if (isExpiredSessionError(error)) return expiredSessionFailure(returnPath);
    console.error(`[action:${actionId}] failed`, error);
    const message = packageErrorMessage(candidate, locale, error);
    // ADR-0012 forbids rendering server `detail`, so the raw reason stays in the
    // log above. The request id is the bridge an operator needs to find it; "安装
    // 失败" alone gives them nothing to search for.
    const requestId = error instanceof ApiError ? error.requestId : undefined;
    // 透出稳定 code（C-1）：页面据此分支/给可操作提示，排障也能直接搜服务端日志。
    // 服务端英文 `detail` 仍然不上屏（ADR-0012）。
    const code = error instanceof ApiError ? error.code : undefined;
    // 上游给出的**原始原因**（支付网关的拒绝原因、渠道返回的 message）走 `detail`。
    // 它不能拼进 `error`（未本地化、可能带内部标识），但必须能拿到：否则
    // 「支付状态无法确认」这种兜底句子会让用户分不清是自己没配好还是网关挂了。
    const detail = error instanceof ApiError ? diagnosticDetail(error) : undefined;
    return actionFailure(message, requestId, code, detail);
  }
  await api
    .recordFrontendAudit('frontend.action.execute', pluginId, actionId, { method: action.method })
    .catch(() => undefined);
  revalidatePath(new URL(returnPath, 'http://stackpanel.local').pathname);
  // An explicitly declared destination wins: it is a real page change (create → detail).
  if (destination) redirect(destination);
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
      // Returning the receipt (instead of redirecting with `?success=`) keeps the
      // server-action promise resolved: a redirect rejects it, and packages that
      // `await` the action then report a successful install as a failure. The
      // client wrapper in `plugin-action-client.ts` toasts it host-side, so the
      // feedback still looks the same to the operator.
      return {
        ok: true,
        message: formatActionSuccessMessage({ ...action.successFeedback, message }, result),
      };
    }
  }
  return { ok: true };
}

/**
 * 为一次插件写操作生成幂等键。
 *
 * 键来自「动作 id + 请求路径 + 规范化后的 body」的 sha256：一次点击生成一个键，
 * 用户再点一次是另一个时间点的同样意图——真正要拦的是“同一个请求被重发”
 * （双击、浏览器重试、网络抖动重放）。因此由表单内容派生，而不是每次随机。
 * 随机键只能在同一次点击的重试中使用，而行动是用户手动触发的第二次点击。
 */
function actionIdempotencyKey(
  action: PluginActionDefinition,
  body: Record<string, string | number | boolean | string[]>,
): string {
  return createHash('sha256')
    .update(`${action.id}|${action.path}|${canonicalBody(body)}`)
    .digest('hex');
}

function canonicalBody(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
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

/** Domain failure: resolve the reason so the page can render it without losing it. */
function actionFailure(
  message: string,
  requestId?: string,
  code?: string,
  detail?: string,
): PluginActionResult {
  return {
    ok: false,
    error: message,
    ...(requestId ? { requestId } : {}),
    ...(code && code !== 'unknown' ? { code } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * 从 problem-details body 里取服务端 `detail`（诊断子原因）。
 *
 * 与 `lib/api-errors.ts` 的同名逻辑一致：只接受非空字符串，避免把对象拼成
 * `[object Object]`。这里单独写一份是因为 `api-errors.ts` 是 `server-only`
 * 且返回已本地化文案，而 action 需要把原文交给页面自行决定怎么展示。
 */
function diagnosticDetail(error: ApiError): string | undefined {
  const details = error.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const detail = (details as { detail?: unknown }).detail;
  return typeof detail === 'string' && detail.trim() ? detail.trim() : undefined;
}

/**
 * Localize a failed action through the **package's** catalog first (ADR-0016 §3).
 *
 * A plugin owns the vocabulary of its own domain: `market.installFailed` means
 * something no kernel-wide sentence can express. Falling back to the kernel
 * catalog keeps codes the kernel defines (`auth.*`, `common.*`) working, and
 * finally to the caller's generic line when neither side has copy — never to the
 * server's English `detail`.
 */
function packageErrorMessage(
  candidate: { id: string; manifest: { messages?: Record<string, Record<string, string>> } },
  locale: Locale,
  error: unknown,
): string {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code) {
    // A package that ships no catalog (or a torn one) must not hide the failure:
    // the lookup is best-effort and the kernel path below always runs.
    try {
      const { messages } = readPackageMessages(candidate.id, candidate.manifest.messages);
      const localized = packageMessage(messages, locale, `error.${code}`, [DEFAULT_LOCALE]);
      if (localized) return localized;
    } catch {
      // fall through to the kernel catalog
    }
  }
  return apiErrorMessageFor(locale, error, translate(locale, 'action.pluginActionFailed'));
}

/** Drop a stale opaque token before routing the operator through a fresh login. */
async function expiredSessionFailure(returnPath: string): Promise<never> {
  await clearSessionCookie();
  redirect(expiredSessionLoginPath(returnPath));
}
