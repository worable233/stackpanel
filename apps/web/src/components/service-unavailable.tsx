import { Button } from '@/components/ui/button';
import { createTranslator } from '@/i18n/core';
import { getLocale } from '@/i18n/locale';

/**
 * 「内核暂时答不上来」的页面 —— 与「未登录」严格区分。
 *
 * 为什么需要它：`getSessionUser()` 曾经把所有异常吞成 `null`，而布局组件把
 * `null` 当成“未登录”并 `redirect('/login')`。于是 api 重启的那几十秒里，
 * 已登录的访客会被踢出登录态，正在填的表单内容全部丢失——他的会话根本没
 * 过期，只是内核暂时不可用。
 *
 * 这里给出 503 语义：告诉用户「服务暂时不可用，稍后重试」，并且**保留**他的
 * 登录态。刷新即可继续，不需要重新登录。
 */
export async function ServiceUnavailable() {
  const locale = await getLocale();
  const t = createTranslator(locale);
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-lg font-medium">{t('common.serviceUnavailableTitle')}</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {t('common.serviceUnavailableHint')}
      </p>
      {/* `<a href="">` 回到当前地址：一次干净的重新渲染，不丢 cookie。 */}
      <Button variant="outline" render={<a href="" />}>
        {t('common.retry')}
      </Button>
    </div>
  );
}
