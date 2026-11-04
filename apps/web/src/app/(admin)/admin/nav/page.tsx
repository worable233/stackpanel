import { Suspense } from 'react';
import { InlineError, PageHeader } from '@stackpanel/ui';
import { AdminNavManager } from '@/components/admin-nav-manager';
import { DataSkeleton } from '@/components/data-skeletons';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

/**
 * 后台菜单编辑（对标 #12.3）。
 *
 * 目前只开放 admin 区域：账户区与公开区的菜单分别由内核默认项和主题决定，
 * 运营改它们的动机还不明确，先不给出入口，避免「能改但没人负责」。
 */
export default async function AdminNavPage() {
  const t = createTranslator(await getLocale());
  return (
    <main className="w-full">
      <PageHeader title={t('adminNav.title')} />
      <p className="mb-4 text-sm text-muted-foreground">{t('adminNav.description')}</p>
      <Suspense fallback={<DataSkeleton variant="settings" />}>
        <AdminNavData />
      </Suspense>
    </main>
  );
}

async function AdminNavData() {
  let items: Awaited<
    ReturnType<Awaited<ReturnType<typeof getAuthedApiClient>>['getAdminNav']>
  >['items'] = [];
  let error: string | null = null;
  try {
    const api = await getAuthedApiClient();
    const result = await api.getAdminNav('admin');
    items = result.items;
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  if (error) return <InlineError>{error}</InlineError>;
  /**
   * `key` 用 items 的**内容指纹**，让 `router.refresh()` 拿到新导航时把
   * `AdminNavManager` 的内部 state 重建一次。
   *
   * 为什么需要：`refresh()` 只会重渲染服务端组件，客户端 state 会存活 ——
   * 没有这一步，新增/删除的菜单项要等整页刷新才出现。
   *
   * 为什么用 key 而不是让子组件在 effect 里 `setRows`：那会在提交渲染之后再
   * 触发一轮渲染（级联），React 19 的 `react-hooks/set-state-in-effect` 明确
   * 警告；渲染期读 ref 又被 `react-hooks/refs` 禁止。key 重置是官方推荐做法。
   *
   * 为什么指纹而不是 `JSON.stringify`：字段顺序固定但内容可能很长，指纹足够
   * 且不会把整份数据塞进 DOM 属性。`dirty` 的语义不受影响 —— 保存成功后
   * 服务端数据也会变，指纹随之变化，正好把重置后的空 dirty 对齐。
   */
  const navKey = JSON.stringify(items.map((item) => [item.href, item.label, item.hidden]));
  return <AdminNavManager key={navKey} surface="admin" items={items} />;
}
