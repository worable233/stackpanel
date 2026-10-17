import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  revalidate: vi.fn(),
  redirect: vi.fn(),
  permission: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/i18n/locale', () => ({ getLocale: async () => 'zh-CN' }));
vi.mock('@/lib/api-errors', () => ({ apiErrorMessage: async () => '保存失败' }));
vi.mock('@/lib/slots', () => ({
  listPluginFrontendCandidates: async () => [
    {
      id: 'storage',
      manifest: {
        actions: [
          {
            id: 'save',
            method: 'POST',
            path: '/storage/config',
            permission: 'storage.admin',
            input: [
              { name: 'endpoint', type: 'string', default: '' },
              { name: 'secret', type: 'string' },
            ],
          },
        ],
      },
    },
  ],
}));
vi.mock('@/lib/api', () => ({
  getAuthedApiClient: async () => ({
    checkPermission: mocks.permission,
    get: async () => ({
      routes: [{ method: 'POST', path: '/storage/config', permission: 'storage.admin' }],
    }),
    post: mocks.post,
    recordFrontendAudit: async () => undefined,
  }),
}));
import { executePluginAction } from '@/lib/frontend-plugin-action-executor';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.mockResolvedValue({ allowed: true });
  mocks.post.mockResolvedValue({});
  mocks.redirect.mockImplementation((path) => {
    throw new Error(`REDIRECT:${path}`);
  });
});
it('clears explicit empty string defaults while preserving write-only secrets, and revalidates only the pathname', async () => {
  const form = new FormData();
  form.set('endpoint', '');
  form.set('secret', '');
  await executePluginAction('storage', 'save', '/admin/settings#plugin-storage-%2Fconfig', form);
  expect(mocks.post).toHaveBeenCalledWith('/storage/config', { endpoint: '' }, expect.anything());
  expect(mocks.revalidate).toHaveBeenCalledWith('/admin/settings');
  expect(mocks.redirect).not.toHaveBeenCalled();
});
it('keeps the active settings section on failure without showing success', async () => {
  mocks.permission.mockResolvedValue({ allowed: false });
  await expect(
    executePluginAction(
      'storage',
      'save',
      '/admin/settings#plugin-storage-%2Fconfig',
      new FormData(),
    ),
  ).rejects.toThrow('REDIRECT:');
  expect(mocks.redirect.mock.calls[0]?.[0]).toMatch(
    /^\/admin\/settings\?action=save&error=.+#plugin-storage-%2Fconfig$/,
  );
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.revalidate).not.toHaveBeenCalled();
});
