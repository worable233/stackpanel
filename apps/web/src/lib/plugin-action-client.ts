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
import type { PluginActionResult } from '@stackpanel/sdk';
import { toast } from '@/components/ui/toast';
import { actionFeedbackTitle, actionSuccessTitle } from '@/components/action-feedback-toaster';

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

/*
 * 这里曾经还有一个 `PluginActionScope`（客户端边界），用来包住**运行时在服务端
 * 解析出来的**页面组件。那是 v0.1.1 首页 500 的根因：服务端组件不能作为 props
 * 跨到客户端边界（`Functions cannot be passed directly to Client Components`），
 * 凡是公开页面都会渲染失败。
 *
 * 所以包装只做在**组件本身就在浏览器里解析**的两条后台路径上
 * （`admin-plugin-page.tsx`、`runtime-admin-page.tsx`）；服务端渲染的公开页面
 * 继续用 `createElement`，由包自己行内展示回执——这是
 * `feedback-success-feedback.test.ts` 允许的第三种形态。
 */
