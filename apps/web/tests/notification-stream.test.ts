import { describe, expect, it } from 'vitest';
import { mergeNotification, shouldToast } from '@/lib/use-notification-stream';
import type { NotificationView } from '@stackpanel/sdk';

function view(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id: 'n1',
    type: 'system.plugin.install',
    title: '插件「示例」安装完成',
    body: '「示例」已安装',
    link: '/admin/plugins',
    data: null,
    status: 'success',
    progress: null,
    readAt: null,
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('mergeNotification', () => {
  it('prepends an unseen notification', () => {
    const a = view({ id: 'a' });
    const merged = mergeNotification([a], view({ id: 'b' }));
    expect(merged.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('replaces an existing notification in place (live activity update)', () => {
    const a = view({ id: 'a', status: 'active', progress: 30 });
    const merged = mergeNotification([a], view({ id: 'a', status: 'success', progress: 100 }));
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe('success');
  });
});

describe('shouldToast', () => {
  it('toasts a settled (success) notification', () => {
    expect(shouldToast(view(), new Set())).toBe(true);
  });

  it('does not toast an in-progress active activity', () => {
    expect(shouldToast(view({ status: 'active', progress: 20 }), new Set())).toBe(false);
  });

  it('toasts an activity once when it settles under the same id', () => {
    // The active frame is skipped; the settled frame with the same id qualifies.
    expect(shouldToast(view({ status: 'active' }), new Set())).toBe(false);
    expect(shouldToast(view({ status: 'success' }), new Set())).toBe(true);
  });

  it('never toasts the same id twice', () => {
    const seen = new Set(['n1']);
    expect(shouldToast(view(), seen)).toBe(false);
  });

  it('does not toast an already-read notification', () => {
    expect(shouldToast(view({ readAt: '2026-10-04T00:00:01.000Z' }), new Set())).toBe(false);
  });

  it('toasts error and info notifications', () => {
    expect(shouldToast(view({ status: 'error' }), new Set())).toBe(true);
    expect(shouldToast(view({ status: 'info' }), new Set())).toBe(true);
  });
});
