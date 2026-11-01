'use client';

import { Suspense, useEffect, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from '@/components/ui/toast';
import { useLocale, useTranslator } from '@/i18n/provider';
import {
  feedbackCodeForAction,
  resolveActionFeedback,
  successCodeForAction,
  type ActionFeedback,
} from '@/lib/action-feedback-codes';

/**
 * 把服务端回执渲染成一条 toast —— **只认 code，不认 URL 原文**。
 *
 * 这里曾经把 `?error=` / `?success=` 的**整段文本**塞进 toast.description：
 * 任何人拼一个
 * `https://站点/admin?action=market.install&success=<攻击者话术>` 的链接发出去，
 * 受害者点开就会看到「看起来来自站点本身」的提示（伪造成功、诱导重新输入密码、
 * 假客服电话……）。同时 URL 只能安全承载有限的字符集，实测截图里出现过 `??????`。
 *
 * 现在的规则（见 `lib/action-feedback-codes.ts`）：
 *
 * - URL 只带 code，文案由本地词表给出；
 * - 未登记的 code → 通用文案 + 小字 code，便于排查但**永不渲染原文**；
 * - 动态文本（计数、上游原文）走一次性 flash（`lib/action-flash.ts`），不进 URL。
 *
 * 参数清理由这里负责：toast 只弹一次，随后把 `action` / `error` / `success` /
 * `flash` 从地址栏抹掉，避免刷新重复提示与「链接可分享出提示」。
 */
function ActionFeedbackToastContent() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslator();
  const locale = useLocale();
  const query = searchParams.toString();

  /** 稳定 id：同一页面同一条反馈只弹一次，重新挂载也不叠加。 */
  const parsed = useMemo(() => {
    const params = new URLSearchParams(query);
    const action = params.get('action');
    const errorCode = params.get('error');
    const successCode = params.get('success');
    const flash = params.get('flash');
    return {
      action,
      error: resolveActionFeedback(locale, 'error', errorCode),
      success: resolveActionFeedback(locale, 'success', successCode),
      flash,
    };
  }, [query, locale]);

  useEffect(() => {
    const { action, error, success } = parsed;
    if (error) {
      toast.error(actionFeedbackTitle(action, t), {
        description: <ActionFeedbackDescription feedback={error} />,
        id: `action-feedback:${action ?? 'unknown'}:${error.code}`,
      });
    } else if (success) {
      toast.success(actionSuccessTitle(action, t), {
        description: <ActionFeedbackDescription feedback={success} />,
        id: `action-success:${action ?? 'unknown'}:${success.code}`,
      });
    } else if (parsed.flash) {
      /**
       * 动态文本走一次性 flash：URL 里只有随机 token，正文在 httpOnly cookie 里。
       * 取一次即作废（接口自己删 cookie），刷新/后退不会重复弹。
       */
      void (async () => {
        try {
          const response = await fetch(
            `/api/action-flash?token=${encodeURIComponent(parsed.flash ?? '')}`,
            { cache: 'no-store' },
          );
          if (!response.ok) return;
          const payload = (await response.json()) as {
            kind: 'error' | 'success';
            message: string;
            code?: string;
            requestId?: string;
          };
          const notify = payload.kind === 'error' ? toast.error : toast.success;
          notify(action ?? t('action.feedback.succeeded'), {
            description: <ActionFeedbackDescription feedback={{ known: true, text: payload.message, code: payload.code ?? '' }} />,
            id: `action-flash:${parsed.flash}`,
          });
        } catch {
          // 取不到就静默：宁可少一条提示，也不要渲染未知来源的文本。
        } finally {
          stripFeedbackQuery();
        }
      })();
      return;
    } else {
      return;
    }

    stripFeedbackQuery();

    function stripFeedbackQuery() {
      const params = new URLSearchParams(query);
      params.delete('action');
      params.delete('error');
      params.delete('success');
      params.delete('flash');
      const next = params.toString();
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    }
  }, [parsed, pathname, query, router, t]);

  return null;
}

/**
 * 反馈正文：命中的 code 显示本地化文案；未命中显示通用文案 + 小字 code。
 *
 * 长文本折叠仍然保留——内核自己的 server action 也可能给出较长的本地化句子
 * （例如带计数的同步摘要），截断掉反而让最需要解释的失败没有任何信息。
 */
function ActionFeedbackDescription({ feedback }: { feedback: ActionFeedback }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="whitespace-pre-wrap break-words">{feedback.text}</span>
      {feedback.known ? null : (
        <code className="text-xs opacity-70" data-feedback-code={feedback.code}>
          {feedback.code}
        </code>
      )}
    </span>
  );
}

/** The shell is static in some deployments, so isolate query access behind Suspense. */
export function ActionFeedbackToaster() {
  return (
    <Suspense fallback={null}>
      <ActionFeedbackToastContent />
    </Suspense>
  );
}

/**
 * 失败提示的标题。
 *
 * `action` 同样来自 URL，所以只做**精确匹配**的 if-else（allowlist）：未知值
 * 一律落到通用文案，绝不把 action 原值渲染出来。
 */
export function actionFeedbackTitle(action: string | null, t: (key: string) => string): string {
  const code = feedbackCodeForAction(action);
  return t(`action.feedback.${code}`);
}

export function actionSuccessTitle(action: string | null, t: (key: string) => string): string {
  const code = successCodeForAction(action);
  return t(`action.feedback.${code}`);
}
