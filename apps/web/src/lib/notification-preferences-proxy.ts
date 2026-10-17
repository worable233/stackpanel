import 'server-only';
import { NextResponse } from 'next/server';
import { ApiError } from '@stackpanel/sdk';
import { z } from 'zod';
import { getBffNotificationClient } from '@/lib/notifications';
import {
  notificationPolicySchema,
  notificationPreferencesSchema,
} from './notification-preferences-schema';
import { getLocale } from '@/i18n/locale';
import { createTranslator } from '@/i18n/core';

type Operation = 'preferences' | 'update' | 'reset' | 'policy' | 'updatePolicy';

/** Fixed upstream endpoints only; session credentials never reach the browser. */
export async function proxyNotificationPreferences(operation: Operation, request?: Request) {
  const t = createTranslator(await getLocale());
  try {
    const api = await getBffNotificationClient();
    let body: unknown;
    if (request) {
      const text = await request.text();
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        return NextResponse.json(
          { error: t('notificationSettings.invalidRequest') },
          { status: 400 },
        );
      }
    }
    let result;
    switch (operation) {
      case 'preferences':
        result = await api.get('/notifications/preferences', notificationPreferencesSchema);
        break;
      case 'update':
        result = await api.patch('/notifications/preferences', body, notificationPreferencesSchema);
        break;
      case 'reset':
        result = await api.post(
          '/notifications/preferences/reset',
          body,
          notificationPreferencesSchema,
        );
        break;
      case 'policy':
        result = await api.get('/admin/notifications/policy', notificationPolicySchema);
        break;
      case 'updatePolicy':
        result = await api.put('/admin/notifications/policy', body, notificationPolicySchema);
        break;
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status =
      error instanceof ApiError
        ? error.status >= 400 && error.status <= 599
          ? error.status
          : 502
        : error instanceof z.ZodError
          ? 502
          : 500;
    const message =
      status === 401
        ? t('common.notLoggedIn')
        : status === 403
          ? t('notificationSettings.forbidden')
          : status >= 500
            ? t('notificationSettings.unavailable')
            : error instanceof Error
              ? error.message
              : t('notificationSettings.failed');
    return NextResponse.json(
      { error: message },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
