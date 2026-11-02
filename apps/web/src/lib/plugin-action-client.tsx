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
          // 只要有 code / reqId / detail 任一项，就走结构化描述：
          // 以前只看 `detail`，所以“操作未完成，请稍后重试”这种兑底文案配上
          // 一个现成的 reqId 也不会显示——运维手里没有任何可搜的标识。
          description:
            result.detail || result.requestId || result.code ? (
              <ActionFailureDescription result={result} />
            ) : (
              result.error
            ),
          id: `action-feedback:${actionId}:${result.code ?? ''}:${result.requestId ?? result.error ?? ''}`,
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

/**
 * 失败正文：主文案是已本地化的句子，原始原因放在可展开的「详情」里。
 *
 * 为什么不能直接把 `detail` 拼进句子：它是服务端/上游的原文（`支付网关返回了
 * HTTP 502`、`商户未开通该支付方式`、`SignatureDoesNotMatch`），未本地化、可带
 * 内部标识，不能当作面向用户的句子（ADR-0012）。也不能丢掉它：像充值这种
 * 「支付状态无法确认」的兜底失败，没有原文就分不清是自己没配好还是网关挂了。
 */
function ActionFailureDescription({ result }: { result: PluginActionResult }) {
  const t = useTranslator();
  return (
    <span className="flex flex-col gap-1">
      <span className="whitespace-pre-wrap break-words">{result.error}</span>
      {/*
        请求 ID 必须能看见。ADR-0012 不允许把服务端 `detail` 当主文案，但运维
        需要一个能在服务端日志里**搜得到**的东西——否则「操作未完成」等于让
        人猜。reqId 本身就是为这个用途存在的。
      */}
      {result.requestId ? (
        <span className="select-all font-mono text-xs opacity-70">
          {t('action.feedback.requestId', { id: result.requestId })}
        </span>
      ) : null}
      {result.code ? (
        <span className="select-all font-mono text-xs opacity-70">{result.code}</span>
      ) : null}
      {result.detail ? (
        <details className="text-xs opacity-80">
          <summary className="cursor-pointer select-none">
            {t('action.feedback.detail')}
          </summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{result.detail}</p>
        </details>
      ) : null}
    </span>
  );
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
