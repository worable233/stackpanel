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

export function serviceCustomName(runtime: unknown): string | null {
  if (!runtime || typeof runtime !== 'object' || !('customName' in runtime)) return null;
  const value = runtime.customName;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function serviceDisplayName(runtime: unknown): string | null {
  return serviceCustomName(runtime) ?? serviceInstanceName(runtime);
}

export function serviceRemark(runtime: unknown): string | null {
  if (!runtime || typeof runtime !== 'object' || !('remark' in runtime)) return null;
  const value = runtime.remark;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export interface ServiceExpiryState {
  /** Whole days until expiry (negative when already expired). */
  days: number;
  expired: boolean;
  soon: boolean;
}

/** Encode the green/amber/red state around a service expiry without locale copy. */
export function serviceExpiryState(
  expiresAt: string | Date | null | undefined,
  now = Date.now(),
): ServiceExpiryState | null {
  if (!expiresAt) return null;
  const end = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (!Number.isFinite(end)) return null;
  const remaining = end - now;
  const days = Math.ceil(remaining / 86_400_000);
  return {
    days: remaining <= 0 ? Math.floor(remaining / 86_400_000) : days,
    expired: remaining <= 0,
    soon: remaining > 0 && remaining <= 7 * 86_400_000,
  };
}

export function canManageService(status: string): boolean {
  return status === 'ACTIVE' || status === 'SUSPENDED';
}

/**
 * 服务详情里「哪一行是公网 IP」。上游返回的标签叫 `IPv4 地址`（带单位/后缀），
 * 旧规则只认 `^ipv4$`，于是列表卡片永远显示「—」，而详情页明明有 154.x.x.x：
 * 买家看不到 IP 就等于拿不到机器。这里按「以 ip 开头 + 词边界」放宽，
 * 同时排除 `IP数量` 这类配置项（后面直接跟汉字）。
 */
export function isPublicIpLabel(label: string): boolean {
  return /公网|public.?ip|^ipv?4?(\s|$)|^ip\s*地址/i.test(label.trim());
}
