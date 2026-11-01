import 'server-only';

import { formatMessage } from '@/i18n/core';
import { isFeedbackCode } from './action-feedback-codes';

interface SuccessFeedback {
  message: string;
  params?: Record<string, string>;
}

/**
 * Build an in-app success receipt consumed by the shared action toaster.
 *
 * **只接受 code**：`?action=…&success=<code>`。改造前这里写的是已本地化的
 * 整句文案（`?success=已保存`），于是任何构造该 URL 的人都能把任意文本反射成
 * 站内 toast（伪造成功提示、钓鱼话术），并且 URL 对字符集敏感（实测出现过
 * `??????`）。文案现在由界面按 code 查表（`lib/action-feedback-codes.ts`）。
 *
 * 非 code 的入参被**丢弃**而不是塞进 URL：宁可少一条提示，也不能让 URL 成为
 * 任意文本的渲染通道。需要动态文本时走一次性 flash（`lib/action-flash.ts`）。
 */
export function actionSuccessUrl(returnPath: string, actionId: string, code: string): string {
  const url = new URL(returnPath, 'http://stackpanel.local');
  url.searchParams.set('action', actionId);
  if (isFeedbackCode(code)) {
    url.searchParams.set('success', code);
  }
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
