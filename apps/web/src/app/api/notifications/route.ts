import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ApiError } from '@stackpanel/sdk';
import { getBffNotificationClient } from '@/lib/notifications';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

/** BFF proxy for GET /notifications (list the current session's inbox). */
export async function GET(request: NextRequest) {
  const t = createTranslator(await getLocale());
  try {
    const api = await getBffNotificationClient();
    const limit = request.nextUrl.searchParams.get('limit');
    const cursor = request.nextUrl.searchParams.get('cursor');
    const unreadOnly = request.nextUrl.searchParams.get('unreadOnly') === 'true';
    const result = await api.getNotifications({
      ...(limit ? { limit: Number(limit) } : {}),
      ...(cursor ? { cursor } : {}),
      ...(unreadOnly ? { unreadOnly } : {}),
    });
    return NextResponse.json(result);
  } catch (error) {
    const status =
      error instanceof ApiError ? error.status : error instanceof Error && 'status' in error ? Number(error.status) : 500;
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
