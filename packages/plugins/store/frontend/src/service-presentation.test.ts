import { describe, expect, it } from 'vitest';
import { canManageService, serviceDate, serviceInstanceName } from './service-presentation';

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
