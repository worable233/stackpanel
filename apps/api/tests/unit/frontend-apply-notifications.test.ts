import { describe, expect, it } from 'vitest';
import { frontendApplyNotification } from '../../src/notifications/frontend-apply-notifications.ts';
import type { FrontendApplyRequest } from '../../src/lib/frontend-apply.ts';

function request(overrides: Partial<FrontendApplyRequest> = {}): FrontendApplyRequest {
  return {
    requestedAt: '2026-10-03T00:00:00.000Z',
    requestedBy: 'user-1',
    reason: 'plugin.install',
    target: 'plugin',
    action: 'install',
    label: '示例插件',
    rebuild: true,
    steps: ['停止当前服务', '编译插件前端资源', '生成前端产物', '重启服务'],
    ...overrides,
  };
}

describe('frontendApplyNotification', () => {
  it('maps a pending status to an active activity', () => {
    const content = frontendApplyNotification(request(), {
      state: 'pending',
      requestedAt: '2026-10-03T00:00:00.000Z',
      target: 'plugin',
      action: 'install',
      step: 1,
      steps: ['停止当前服务', '编译插件前端资源', '生成前端产物', '重启服务'],
    });
    expect(content.status).toBe('active');
    expect(content.title).toContain('安装');
    expect(content.title).toContain('示例插件');
    expect(content.progress).toBeGreaterThan(0);
    expect(content.data).toMatchObject({ kind: 'frontend-apply', state: 'pending', step: 1, total: 4 });
  });

  it('maps a success status to a finished notification at 100%', () => {
    const content = frontendApplyNotification(request(), {
      state: 'succeeded',
      requestedAt: '2026-10-03T00:00:00.000Z',
      target: 'plugin',
      action: 'install',
      step: 4,
      steps: ['a', 'b', 'c', 'd'],
      message: '插件「示例插件」已生效',
    });
    expect(content.status).toBe('success');
    expect(content.progress).toBe(100);
    expect(content.title).toContain('完成');
    expect(content.body).toBe('插件「示例插件」已生效');
  });

  it('maps a failed status to an error notification carrying the reason', () => {
    const content = frontendApplyNotification(request({ action: 'remove', target: 'theme' }), {
      state: 'failed',
      requestedAt: '2026-10-03T00:00:00.000Z',
      target: 'theme',
      action: 'remove',
      step: 3,
      message: '前端变更未生效：Web 构建失败',
    });
    expect(content.status).toBe('error');
    expect(content.progress).toBe(100);
    expect(content.title).toContain('主题');
    expect(content.body).toBe('前端变更未生效：Web 构建失败');
  });
});
