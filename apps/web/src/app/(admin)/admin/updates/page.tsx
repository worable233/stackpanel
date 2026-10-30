import type {
  UpdateResultsResponse,
  UpdateSelfUpdateResponse,
  UpdateStatusResponse,
} from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import packageInfo from '../../../../../../../package.json';
import { UpdateCenter } from './update-center';

/**
 * 更新中心。
 *
 * 首屏数据全部是**只读投影**（`GET /admin/updates/status|results|self-update`），
 * 不会出网：目录请求只由页面上的「检查更新」显式触发。旧实现在这里隐式调用
 * `updateCatalogContext()`，进程刚启动时进页面就会被 GitHub 请求拖住。
 *
 * 三份数据并行取，任何一个非关键项失败都只降级为空列表/空请求，不拖垮整页——
 * 「updater 没在跑」是常见状态，页面仍然要把当前部署、目录配置与历史展示出来。
 */
export default async function AdminUpdatesPage() {
  const t = createTranslator(await getLocale());
  let initial: UpdateStatusResponse | null = null;
  let results: UpdateResultsResponse['results'] = [];
  let selfUpdate: UpdateSelfUpdateResponse['request'] = null;
  let error: string | null = null;

  try {
    const api = await getAuthedApiClient();
    const [status, taskResults, selfUpdateResponse] = await Promise.all([
      api.getUpdateStatus(),
      api.listUpdateResults().catch(() => ({ results: [] }) as UpdateResultsResponse),
      api.getUpdateSelfUpdate().catch(() => ({ request: null }) as UpdateSelfUpdateResponse),
    ]);
    initial = status;
    results = taskResults.results;
    selfUpdate = selfUpdateResponse.request;
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  return (
    <main className="w-full space-y-6">
      <PageHeader title={t('admin.updates.title')} />
      {error ? (
        <div className="space-y-1">
          <p className="text-sm text-destructive">{t('admin.updates.serviceUnavailable')}</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      ) : initial ? (
        <UpdateCenter
          currentVersion={packageInfo.version}
          initial={initial}
          initialResults={results}
          initialSelfUpdate={selfUpdate}
        />
      ) : null}
    </main>
  );
}
