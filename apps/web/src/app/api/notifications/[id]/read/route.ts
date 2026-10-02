import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ApiError } from '@stackpanel/sdk';
import { getBffNotificationClient } from '@/lib/notifications';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

export const dynamic = 'force-dynamic';

/** BFF proxy for POST /notifications/:id/read. */
export async function POST(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const t = createTranslator(await getLocale());
  try {
    const { id } = await ctx.params;
    const api = await getBffNotificationClient();
    await api.markNotificationRead(id);
    return NextResponse.json({ ok: true });
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
