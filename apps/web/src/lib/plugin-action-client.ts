'use client';

/**
 * 插件 action 的客户端包装（`docs/design/feedback-ux-handoff.md` §4）。
 *
 * 服务端 `executePluginAction` 对**业务结果**返回 `{ ok, message?, error? }`，只有
 * 真导航（`action.redirect`、会话过期）才 reject。包装层做两件事：
 *
 * 1. 把回执/原因交给宿主共享 toaster —— 与改造前 `?action=…&success|error=…`
 *    的表现一致，包自己不用再复制一套提示；
 * 2. 原样返回结果，页面要行内展示精确原因时直接 `result.error`。
 *
 * 为什么不在服务端 redirect：Next 的 server action 以 reject 表达 redirect，插件
 * 前端 `await action(formData)` 会把**成功**当失败（市场页曾因此把装好的插件报成
 * 「安装失败，请重试」，而服务端日志是 200 + `Plugin activated`）。
 */
import type { ComponentType, ReactElement } from 'react';
import { createElement, useMemo } from 'react';
import type { PluginActionResult } from '@stackpanel/sdk';
import { toast } from '@/components/ui/toast';
import { actionFeedbackTitle, actionSuccessTitle } from '@/components/action-feedback-toaster';
import { useTranslator } from '@/i18n/provider';

type RawAction = (formData: FormData) => Promise<unknown>;

/**
 * Wrap the bound server actions of one package so feedback is toasted once,
 * host-side, and the page still receives the structured result.
 */
export function wrapPluginActions(
  raw: Record<string, unknown>,
  t: (key: string) => string,
): Record<string, RawAction> {
  const wrapped: Record<string, RawAction> = {};
  for (const [actionId, candidate] of Object.entries(raw ?? {})) {
    if (typeof candidate !== 'function') continue;
    const action = candidate as RawAction;
    wrapped[actionId] = async (formData: FormData): Promise<PluginActionResult> => {
      const result = (await action(formData)) as PluginActionResult | undefined;
      if (result && result.ok === false) {
        toast.error(actionFeedbackTitle(actionId, t), {
          description: result.error,
          id: `action-feedback:${actionId}:${result.error ?? ''}`,
        });
        return result;
      }
      if (result?.ok && result.message) {
        toast.success(actionSuccessTitle(actionId, t), {
          description: result.message,
          id: `action-success:${actionId}:${result.message}`,
        });
      }
      return result ?? { ok: true };
    };
  }
  return wrapped;
}

/** Props shape shared by the admin and public render paths. */
export interface WrappedPageProps {
  actions?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Render a package page with wrapped actions. Client boundary so the wrapper can
 * use the host toaster; the page component itself is unchanged.
 */
export function PluginActionScope({
  component,
  props,
}: {
  component: ComponentType<never>;
  props: WrappedPageProps;
}): ReactElement {
  const t = useTranslator();
  const rawActions = props.actions;
  const actions = useMemo(
    () => (rawActions ? wrapPluginActions(rawActions, t) : rawActions),
    [rawActions, t],
  );
  return createElement(component, { ...props, actions } as never) as unknown as ReactElement;
}
