import { NextResponse } from 'next/server';
import { ApiError } from '@stackpanel/sdk';
import { getBffNotificationClient } from '@/lib/notifications';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

/** BFF proxy for POST /notifications/read-all. */
export async function POST() {
  const t = createTranslator(await getLocale());
  try {
    const api = await getBffNotificationClient();
    const result = await api.markAllNotificationsRead();
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof Error && 'status' in error ? Number(error.status) : 500;
    const message = error instanceof Error ? error.message : t('api.notificationsUnavailable');
    if (status === 401) {
      return NextResponse.json({ error: t('common.notLoggedIn') }, { status: 401 });
    }
    return NextResponse.json(
      { error: message, ...(error instanceof ApiError ? { code: error.code } : {}) },
      { status: 500 },
    );
  }
}
