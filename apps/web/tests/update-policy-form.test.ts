import { describe, expect, it } from 'vitest';
import {
  buildUpdatePolicyPatch,
  parseExcluded,
  parsePinned,
  parseWindow,
  readUpdatePolicyForm,
  type UpdatePolicyFormValues,
} from '@/lib/update-policy-form';

const base: UpdatePolicyFormValues = {
  autoUpdate: false,
  channel: 'stable',
  autoUpdateKernel: false,
  windowEnabled: false,
  windowStart: '',
  windowEnd: '',
  excluded: '',
  pinned: '',
  allowPermissionIncrease: false,
  allowIrreversibleMigration: false,
};

describe('parseExcluded', () => {
  it('splits lines, trims, drops blanks and comments', () => {
    expect(parseExcluded('plugin/a\n\n  theme/b  \n# 说明\nplugin/c')).toEqual({
      value: ['plugin/a', 'theme/b', 'plugin/c'],
    });
  });

  it('dedupes while keeping order', () => {
    expect(parseExcluded('plugin/a\nplugin/a')).toEqual({ value: ['plugin/a'] });
  });

  it('rejects keys the kernel would never match', () => {
    // 内核按 `${kind}/${id}` 拼接匹配（apps/api/src/updates/policy.ts），
    // 写错的键会被静默忽略，所以在写库前就拒绝。
    expect(parseExcluded('remote-analytics')).toEqual({ detail: 'remote-analytics' });
    expect(parseExcluded('plugin/')).toEqual({ detail: 'plugin/' });
    expect(parseExcluded('frontend/thing')).toEqual({ detail: 'frontend/thing' });
  });
});

describe('parsePinned', () => {
  it('accepts space and @ separators', () => {
    expect(parsePinned('plugin/a 1.2.3\ntheme/b@2.0.0')).toEqual({
      value: { 'plugin/a': '1.2.3', 'theme/b': '2.0.0' },
    });
  });

  it('accepts prerelease versions', () => {
    expect(parsePinned('plugin/a 1.2.3-beta.1')).toEqual({ value: { 'plugin/a': '1.2.3-beta.1' } });
  });

  it('rejects a bare version or an extra field', () => {
    expect(parsePinned('1.2.3')).toEqual({ detail: '1.2.3' });
    expect(parsePinned('plugin/a 1.2.3 extra')).toEqual({ detail: 'plugin/a 1.2.3 extra' });
  });
});

describe('parseWindow', () => {
  it('parses 0-23 and allows the wrap-around window', () => {
    expect(parseWindow('1', '3')).toEqual({ value: { startHour: 1, endHour: 3 } });
    expect(parseWindow('22', '6')).toEqual({ value: { startHour: 22, endHour: 6 } });
  });

  it('rejects empty or out-of-range hours', () => {
    expect(parseWindow('', '3')).toEqual({ detail: '-3' });
    expect(parseWindow('24', '3')).toEqual({ detail: '24-3' });
    expect(parseWindow('1.5', '3')).toEqual({ detail: '1.5-3' });
  });
});

describe('buildUpdatePolicyPatch', () => {
  it('always sends the whole form so stale fields cannot linger', () => {
    const result = buildUpdatePolicyPatch({
      ...base,
      autoUpdate: true,
      channel: 'beta',
      allowPermissionIncrease: true,
    });
    expect(result).toEqual({
      ok: true,
      patch: {
        autoUpdate: true,
        channel: 'beta',
        autoUpdateKernel: false,
        excluded: [],
        pinned: {},
        maintenanceWindow: null,
        allowPermissionIncrease: true,
        allowIrreversibleMigration: false,
      },
    });
  });

  it('sends an explicit null when the window is disabled', () => {
    // 关闭窗口必须表达成 `maintenanceWindow: null`（清除），
    // 而不是省略字段——省略等于「保留原值」，窗口就再也关不掉了。
    const result = buildUpdatePolicyPatch({ ...base, windowEnabled: false });
    expect(result.ok && result.patch.maintenanceWindow).toBeNull();
  });

  it('sends the window when enabled', () => {
    const result = buildUpdatePolicyPatch({
      ...base,
      windowEnabled: true,
      windowStart: '2',
      windowEnd: '4',
    });
    expect(result.ok && result.patch.maintenanceWindow).toEqual({ startHour: 2, endHour: 4 });
  });

  it('reports the offending field on invalid input', () => {
    expect(buildUpdatePolicyPatch({ ...base, channel: 'nightly' })).toEqual({
      ok: false,
      field: 'channel',
      detail: 'nightly',
    });
    expect(buildUpdatePolicyPatch({ ...base, excluded: 'nope' })).toEqual({
      ok: false,
      field: 'excluded',
      detail: 'nope',
    });
    expect(buildUpdatePolicyPatch({ ...base, pinned: 'plugin/a nope' })).toEqual({
      ok: false,
      field: 'pinned',
      detail: 'plugin/a nope',
    });
    expect(
      buildUpdatePolicyPatch({ ...base, windowEnabled: true, windowStart: '9', windowEnd: '' }),
    ).toEqual({ ok: false, field: 'window', detail: '9-' });
  });
});

describe('readUpdatePolicyForm', () => {
  it('treats an absent checkbox as false and a missing channel as stable', () => {
    const formData = new FormData();
    formData.set('autoUpdate', 'on');
    expect(readUpdatePolicyForm(formData)).toEqual({
      autoUpdate: true,
      channel: 'stable',
      autoUpdateKernel: false,
      windowEnabled: false,
      windowStart: '',
      windowEnd: '',
      excluded: '',
      pinned: '',
      allowPermissionIncrease: false,
      allowIrreversibleMigration: false,
    });
  });
});
