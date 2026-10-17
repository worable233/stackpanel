import { proxyNotificationPreferences } from '@/lib/notification-preferences-proxy';
export const dynamic = 'force-dynamic';
export async function GET() {
  return proxyNotificationPreferences('preferences');
}
export async function PATCH(request: Request) {
  return proxyNotificationPreferences('update', request);
}
