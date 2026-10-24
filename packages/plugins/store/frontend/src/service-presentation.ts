import { PACKAGE_FALLBACK_LOCALE } from '@stackpanel/sdk';

export function serviceDate(
  value: string | null,
  locale: string = PACKAGE_FALLBACK_LOCALE,
): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
    hour12: false,
  }).format(new Date(value));
}

export function serviceInstanceName(runtime: unknown): string | null {
  if (!runtime || typeof runtime !== 'object' || !('instanceName' in runtime)) return null;
  return typeof runtime.instanceName === 'string' && runtime.instanceName.trim()
    ? runtime.instanceName.trim()
    : null;
}

export function canManageService(status: string): boolean {
  return status === 'ACTIVE' || status === 'SUSPENDED';
}
