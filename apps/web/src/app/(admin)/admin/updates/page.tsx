import type { UpdateStatusResponse } from '@stackpanel/sdk';
import { PageHeader } from '@stackpanel/ui';
import { getAuthedApiClient } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api-errors';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';
import { UpdateCenter } from './update-center';

export default async function AdminUpdatesPage() {
  const t = createTranslator(await getLocale());
  let initial: UpdateStatusResponse | null = null;
  let error: string | null = null;
  try {
    const api = await getAuthedApiClient();
    initial = await api.getUpdateStatus();
  } catch (err) {
    error = await apiErrorMessage(err);
  }

  return (
    <main className="w-full space-y-6">
      <PageHeader
        title={t('admin.updates.title')}
        description={t('admin.updates.pageDescription')}
      />
      {error ? (
        <p className="text-sm text-destructive">
          {t('admin.updates.serviceUnavailable', { error })}
        </p>
      ) : initial ? (
        <UpdateCenter initial={initial} />
      ) : null}
    </main>
  );
}
