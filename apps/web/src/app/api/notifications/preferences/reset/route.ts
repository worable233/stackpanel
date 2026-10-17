import { proxyNotificationPreferences } from '@/lib/notification-preferences-proxy';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return proxyNotificationPreferences('reset', request);
}
