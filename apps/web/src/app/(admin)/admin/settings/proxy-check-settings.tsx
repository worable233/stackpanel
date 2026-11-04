'use client';

/**
 * 反代自检面板（系统设置 → 反代自检）。
 *
 * 为什么需要一个面板而不是只写文档：0.1.x 的三条线上事故（后台 POST 全 403、
 * 全员共用一个 IP、插件前端 404）在界面上**都长得像别的问题** ——「请求来源无效」
 * 「操作太频繁」「插件坏了」。运维不会想到是反代的头。
 *
 * 所以这里把内核实际看到的部署事实（对端地址、转发头、同源判定）摊开，每条不通过
 * 的项直接给出可执行的修复动作与文档锚点。判定的**结论**由内核用与 Web BFF 同一份
 * 实现算出（`@stackpanel/sdk` 的 `checkOrigin`），不会出现「诊断说通过、真实请求
 * 403」。
 */
import { useCallback, useEffect, useState, useTransition } from 'react';
import type { ProxyCheckResponse } from '@stackpanel/sdk';
import { Badge, Button } from '@stackpanel/ui';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { ProxyCheckRequestError, proxyCheckFromBrowser } from '@/lib/proxy-check-client';
import { useTranslator } from '@/i18n/provider';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; report: ProxyCheckResponse }
  | { kind: 'error'; message: string };

export function ProxyCheckSettings() {
  const t = useTranslator();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [pending, startTransition] = useTransition();

  /**
   * `announce` 为 false 时把 `loading` 状态留给初值。
   *
   * 首屏那一次由 `useEffect` 触发，而 `state` 的初值已经是
   * `{ kind: 'loading' }` —— 再设一次是在 effect 里同步 setState，会触发级联
   * 渲染。手动「重新检查」时才需要显式回到 loading。
   */
  const load = useCallback(async (announce = true) => {
    if (announce) setState({ kind: 'loading' });
    try {
      // **必须由浏览器直接请求内核**：这个面板要检查的正是「浏览器 → 反代 → 内核」
      // 这一跳的头。走 BFF（服务端转发）测出来的是 `web → api` 那一跳 —— 内网直连、
      // 永远没有 X-Forwarded-*，只会得到一堆假绿。
      const report = await proxyCheckFromBrowser();
      setState({ kind: 'ready', report });
    } catch (error) {
      setState({ kind: 'error', message: describeFailure(error, t) });
    }
  }, [t]);

  useEffect(() => {
    // 首屏自动跑一次：这个面板的全部意义是「打开就看到对不对」，不该还要点一下。
    // 放进 transition：`load` 内部会 setState，直接在 effect 里同步调用会触发
    // 级联渲染（React 19 的 set-state-in-effect 规则）。
    startTransition(() => void load(false));
  }, [load]);

  const refresh = () => startTransition(() => void load());

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">{t('admin.settings.proxyCheck.intro')}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={pending || state.kind === 'loading'}
        >
          {pending || state.kind === 'loading' ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {t('admin.settings.proxyCheck.refresh')}
        </Button>
      </div>

      {state.kind === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('admin.settings.proxyCheck.loading')}
        </p>
      ) : state.kind === 'error' ? (
        <p className="text-sm text-destructive">
          {t('admin.settings.proxyCheck.failed')}: {state.message}
        </p>
      ) : (
        <Report report={state.report} />
      )}
    </div>
  );
}

/**
 * 把请求失败翻译成用户能读的一句话。
 *
 * 401/403 是最可能的失败（没登录 / 不是管理员），必须与「内核没这个端点」（旧版本）
 * 区分开 —— 后者的正确动作是升级内核，而不是去查反代。
 */
function describeFailure(error: unknown, t: (key: string) => string): string {
  if (error instanceof ProxyCheckRequestError) {
    if (error.status === 401 || error.status === 403) {
      return `${t('admin.settings.proxyCheck.failed')} (HTTP ${error.status})`;
    }
    if (error.status === 404) {
      return `${t('admin.settings.proxyCheck.failed')} (HTTP 404)`;
    }
    return `${t('admin.settings.proxyCheck.failed')} (HTTP ${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}

function Report({ report }: { report: ProxyCheckResponse }) {
  const t = useTranslator();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={report.ok ? 'secondary' : 'destructive'}>
          {report.ok
            ? t('admin.settings.proxyCheck.allGood')
            : t('admin.settings.proxyCheck.hasIssues')}
        </Badge>
        <span className="text-muted-foreground">
          {t('admin.settings.proxyCheck.clientIp')}: <code>{report.clientIp}</code>
          {' · '}
          {t('admin.settings.proxyCheck.peer')}: <code>{report.peer}</code>
          {' · '}
          API_TRUST_PROXY: <code>{report.trustProxy}</code>
        </span>
      </div>

      <ul className="divide-y rounded-md border">
        {report.items.map((item) => (
          <li key={item.id} className="flex gap-3 p-3 text-sm">
            {item.ok ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            )}
            <div className="flex min-w-0 flex-col gap-1">
              {/* 未知 id 回落到 id 本身：内核可能比这个前端新，多出一项也不该空着。 */}
              <p className="font-medium">
                {t(`admin.settings.proxyCheck.item.${item.id}`) ===
                `admin.settings.proxyCheck.item.${item.id}`
                  ? item.id
                  : t(`admin.settings.proxyCheck.item.${item.id}`)}
              </p>
              <p className="break-words text-muted-foreground">{item.detail}</p>
              {item.fix ? (
                <p className="flex items-start gap-1.5 break-words text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{item.fix}</span>
                </p>
              ) : null}
              {item.doc ? (
                <p className="text-xs text-muted-foreground">
                  {t('admin.settings.proxyCheck.docHint')}: <code>{item.doc}</code>
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {report.warnings.length > 0 ? (
        <div className="rounded-xl bg-destructive/10 p-3">
          <p className="mb-1 text-sm font-medium text-destructive">
            {t('admin.settings.proxyCheck.warnings')}
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {report.warnings.map((warning) => (
              <li key={warning} className="break-words">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <span>
          {t('admin.settings.proxyCheck.forwardedProto')}:{' '}
          <code>{report.forwardedProto ?? '—'}</code>
        </span>
        <span>
          {t('admin.settings.proxyCheck.forwardedHost')}:{' '}
          <code>{report.forwardedHost ?? '—'}</code>
        </span>
        <span>
          {t('admin.settings.proxyCheck.forwardedFor')}:{' '}
          <code>{report.forwardedFor ?? '—'}</code>
        </span>
        <span>
          {t('admin.settings.proxyCheck.originGuard')}:{' '}
          <code>{report.originGuardWouldPass ? 'pass' : 'fail'}</code>
        </span>
      </div>
    </div>
  );
}
