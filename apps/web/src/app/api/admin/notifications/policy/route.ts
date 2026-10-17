import { proxyNotificationPreferences } from '@/lib/notification-preferences-proxy';
export const dynamic = 'force-dynamic';
export async function GET() {
  return proxyNotificationPreferences('policy');
}
export async function PUT(request: Request) {
  return proxyNotificationPreferences('updatePolicy', request);
}
