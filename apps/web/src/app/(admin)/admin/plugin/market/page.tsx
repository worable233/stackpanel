import { redirect } from 'next/navigation';

/** 插件市场已并入插件管理的「发现」页，旧地址保持可用。 */
export default function AdminMarketRedirectPage(): never {
  redirect('/admin/plugins?tab=market');
}
