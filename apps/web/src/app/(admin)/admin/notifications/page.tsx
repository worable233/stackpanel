import { NotificationInbox } from '@/components/notification-inbox';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

export default async function AdminNotificationsPage() {
  const t = createTranslator(await getLocale());
  return (
    <main className="w-full">
      <NotificationInbox
        title={t('admin.notifications.title')}
        description={t('admin.notifications.description')}
      />
    </main>
  );
}
