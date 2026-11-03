'use client';

import type { ReactElement } from 'react';
import { InlineError } from '@stackpanel/ui';
import { useTranslator } from '@/i18n/provider';

/**
 * 「插件前端加载失败」的可诊断错误卡。
 *
 * 为什么需要它：装载失败以前一律归到 `not-found`，界面上只说「未找到插件管理页面」
 * 或「未找到这个账户页面」。运维看到的是一个 404，而真实原因是服务端 `import()`
 * 抛错——两者排查方向完全不同。v0.1.1 线上 `/account/referral` 连续 57 次同一条
 * 报错，界面却一直显示「页面不存在」。
 *
 * 这里只展示**插件 id** 与**失败原因**：前者定位是哪个包，后者（例如
 * `does not provide an export named 'useState'`）直接指向根因。堆栈与完整对象仍在
 * 服务端日志里（`[frontend-runtime] failed to load …`），因为浏览器不需要、也不该
 * 拿到模块路径。
 */
export function PluginFrontendBroken({
  pluginId,
  reason,
}: {
  pluginId: string;
  reason: string;
}): ReactElement {
  const t = useTranslator();
  return (
    <div className="flex flex-col gap-3">
      <InlineError>{t('pluginPage.brokenTitle')}</InlineError>
      <p className="text-sm text-muted-foreground">
        {t('pluginPage.brokenHint', { pluginId })}
      </p>
      <div className="rounded-2xl bg-muted/40 p-3">
        <p className="text-xs font-medium text-muted-foreground">
          {t('pluginPage.brokenReason')}
        </p>
        {/* 失败原因是宿主诊断信息（Node 的 SyntaxError 文本），不做翻译。 */}
        <p className="mt-1 font-mono text-xs break-words">{reason}</p>
      </div>
    </div>
  );
}
