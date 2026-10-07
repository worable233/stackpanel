import { describe, expect, it, vi } from 'vitest';
import type { NotificationsService } from '@stackpanel/sdk';
import {
  createLifecycleNotifier,
  lifecycleNotification,
  type LifecycleNotificationEvent,
} from '../../src/notifications/lifecycle-notifications.ts';

function event(overrides: Partial<LifecycleNotificationEvent> = {}): LifecycleNotificationEvent {
  return {
    target: 'plugin',
    action: 'install',
    label: '示例插件',
    id: 'demo',
    version: '1.0.0',
    ok: true,
    ...overrides,
  };
}

describe('lifecycleNotification', () => {
  it('renders a successful plugin install', () => {
    const content = lifecycleNotification(event());
    expect(content.status).toBe('success');
    expect(content.type).toBe('system.plugin.install');
    expect(content.title).toBe('插件「示例插件」安装完成');
    expect(content.body).toContain('已安装');
    expect(content.body).toContain('v1.0.0');
    expect(content.link).toBe('/admin/plugins');
    expect(content.data).toMatchObject({ kind: 'lifecycle', target: 'plugin', ok: true });
  });

  it('renders a theme activation with the theme console link', () => {
    const content = lifecycleNotification({
      target: 'theme',
      action: 'activate',
      label: '暗色主题',
      id: 'dark',
      ok: true,
    });
    expect(content.status).toBe('success');
    expect(content.type).toBe('system.theme.activate');
    expect(content.title).toBe('主题「暗色主题」已激活');
    expect(content.link).toBe('/admin/themes');
    expect(content.body).not.toContain('v');
  });

  it('renders a failure carrying the reason as an error', () => {
    const content = lifecycleNotification(
      event({ action: 'update', ok: false, error: '依赖版本不兼容' }),
    );
    expect(content.status).toBe('error');
    expect(content.type).toBe('system.plugin.update');
    expect(content.title).toBe('插件「示例插件」升级失败');
    expect(content.body).toBe('依赖版本不兼容');
    expect(content.data).toMatchObject({ ok: false });
  });

  it('falls back to generic copy when a failed event omits a reason', () => {
    const content = lifecycleNotification(event({ action: 'disable', ok: false }));
    expect(content.status).toBe('error');
    expect(content.title).toBe('插件「示例插件」停用失败');
    expect(content.body).toContain('未完成');
  });
});

describe('createLifecycleNotifier', () => {
  function fakeService() {
    return { create: vi.fn().mockResolvedValue({}) } as unknown as NotificationsService & {
      create: ReturnType<typeof vi.fn>;
    };
  }

  it('writes one notification for the acting user', async () => {
    const notifications = fakeService();
    const notify = createLifecycleNotifier({ notifications });
    await notify('user-1', event());
    expect(notifications.create).toHaveBeenCalledTimes(1);
    const input = notifications.create.mock.calls[0]?.[0] as { userId: string; status: string; title: string };
    expect(input.userId).toBe('user-1');
    expect(input.status).toBe('success');
    expect(input.title).toContain('安装完成');
  });

  it('is a no-op without an actor', async () => {
    const notifications = fakeService();
    const notify = createLifecycleNotifier({ notifications });
    await notify(null, event());
    await notify(undefined, event());
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('swallows write failures (best-effort) and logs them', async () => {
    const notifications = fakeService();
    notifications.create.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.fn();
    const notify = createLifecycleNotifier({ notifications, logger: { warn } });
    await expect(notify('user-1', event())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });
});
