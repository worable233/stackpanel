import { describe, expect, it } from 'vitest';
import { canManageService, isPublicIpLabel, serviceDate, serviceInstanceName } from './service-presentation';

describe('service console presentation', () => {
  it.each([
    'PROVISIONING',
    'PENDING_PROVISION',
    'AWAITING_APPROVAL',
    'FAILED',
    'TERMINATED',
    'unknown',
  ])('does not expose operational panels for %s', (status) =>
    expect(canManageService(status)).toBe(false),
  );
  it.each(['ACTIVE', 'SUSPENDED'])('allows managed panels for %s', (status) =>
    expect(canManageService(status)).toBe(true),
  );
  it.each([null, {}, { instanceName: 5 }, { instanceName: '  ' }, 'unsafe'])(
    'ignores missing or invalid instance names: %j',
    (runtime) => expect(serviceInstanceName(runtime)).toBeNull(),
  );
  it('uses the persisted instance name, not credentials', () => {
    expect(serviceInstanceName({ instanceName: ' production-db ', password: 'never-render' })).toBe(
      'production-db',
    );
  });
  it.each([null, '', 'bad-date'])('does not invent missing dates: %s', (value) =>
    expect(serviceDate(value, 'zh-CN')).toBe('—'),
  );
  it('preserves hours and minutes with an explicit timezone', () => {
    expect(serviceDate('2026-10-21T05:49:00Z', 'zh-CN')).toContain('13:49');
  });
});

/**
 * 列表卡片的公网 IP 来自详情字段的标签匹配。上游用的是「IPv4 地址」，
 * 旧正则 `^ipv4$` 匹配不上 → 卡片显示「—」，买家以为机器没有 IP。
 */
describe('isPublicIpLabel', () => {
  it.each(['IPv4 地址', 'IPv4', 'IP', 'IP 地址', '公网 IP', 'Public IP'])(
    'identifies the public-IP field labeled %s',
    (label) => expect(isPublicIpLabel(label)).toBe(true),
  );
  it.each(['IP数量', 'vCPU', '带宽'])('does not treat configuration rows as an IP: %s', (label) =>
    expect(isPublicIpLabel(label)).toBe(false),
  );
});
