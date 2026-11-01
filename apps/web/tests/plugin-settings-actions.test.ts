import { ApiError } from '@stackpanel/sdk';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  revalidate: vi.fn(),
  redirect: vi.fn(),
  permission: vi.fn(),
  deleteCookie: vi.fn(),
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
  ] as Array<Record<string, unknown>>,
  extraManifest: {} as Record<string, unknown>,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ delete: mocks.deleteCookie }),
}));
vi.mock('@/i18n/locale', () => ({ getLocale: async () => 'zh-CN' }));
vi.mock('@/lib/api-errors', () => ({
  apiErrorMessage: async () => '保存失败',
  apiErrorMessageFor: () => '保存失败',
}));
vi.mock('@/lib/slots', () => ({
  listPluginFrontendCandidates: async () => [
    {
      id: 'storage',
      manifest: { actions: mocks.actions, ...mocks.extraManifest },
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
import { actionSuccessUrl, formatActionSuccessMessage } from '@/lib/frontend-plugin-action-feedback';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.mockResolvedValue({ allowed: true });
  mocks.post.mockResolvedValue({});
  mocks.extraManifest = {};
  mocks.actions = [
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
  ];
  mocks.redirect.mockImplementation((path) => {
    throw new Error(`REDIRECT:${path}`);
  });
});
it('clears explicit empty string defaults while preserving write-only secrets, and revalidates only the pathname', async () => {
  const form = new FormData();
  form.set('endpoint', '');
  form.set('secret', '');
  await executePluginAction('storage', 'save', '/admin/settings#plugin-storage-%2Fconfig', form);
  // 第三个参数是 `post` 的 zod schema + 幂等键。用 `toHaveBeenCalledWith` 的
  // `expect.anything()` 不行（它不匹配 Zod 的类实例），也不该断言 Zod 内部字段
  // （`_def` → `def` 已经改过一次）。直接取实参检查。
  const [path, body, schema, idempotencyKey] = mocks.post.mock.calls[0] as unknown[];
  expect(path).toBe('/storage/config');
  expect(body).toEqual({ endpoint: '' });
  expect(schema).toBeDefined();
  expect(typeof idempotencyKey).toBe('string');
  expect(mocks.revalidate).toHaveBeenCalledWith('/admin/settings');
  expect(mocks.redirect).not.toHaveBeenCalled();
});
it('preserves the active route while carrying a declared success code', () => {
  // URL 只带 code（`?success=<code>`）：文案由界面查表，URL 不再是文案通道。
  expect(actionSuccessUrl('/admin/settings?tab=plugin#storage', 'storage.save', 'succeeded')).toBe(
    '/admin/settings?tab=plugin&action=storage.save&success=succeeded#storage',
  );
});
it('drops a non-code receipt instead of reflecting it into the URL', () => {
  // 传入整句文案（历史调用 / 误用）时宁可不带提示，也不能让它进 URL 被反射。
  expect(actionSuccessUrl('/admin/settings', 'storage.save', '已保存')).toBe(
    '/admin/settings?action=storage.save',
  );
  expect(actionSuccessUrl('/admin/settings', 'storage.save', 'a'.repeat(65))).toBe(
    '/admin/settings?action=storage.save',
  );
});
it('formats a declared sync summary from finite numeric response fields only', () => {
  expect(
    formatActionSuccessMessage(
      {
        message: '同步完成：已更新 {updated} 个商品，跳过 {skipped} 个。',
        params: { updated: 'updated', skipped: 'skipped', ignored: 'message' },
      },
      { updated: 3, skipped: 1, message: '不应进入反馈' },
    ),
  ).toBe('同步完成：已更新 3 个商品，跳过 1 个。');
});
it('resolves the receipt instead of redirecting once the action completes and revalidates', async () => {
  mocks.actions = [
    {
      id: 'save',
      method: 'POST',
      path: '/storage/config',
      permission: 'storage.admin',
      successFeedback: { message: '已保存' },
    },
  ];
  // Resolving (not redirecting) is the fix for「成功被界面报成失败」：Next 用 reject
  // 表达 redirect，包 `await action()` 会把成功当失败（docs/design/feedback-ux-handoff.md §4.1）。
  await expect(
    executePluginAction('storage', 'save', '/admin/settings#storage', new FormData()),
  ).resolves.toEqual({ ok: true, message: '已保存' });
  expect(mocks.redirect).not.toHaveBeenCalled();
  expect(mocks.revalidate).toHaveBeenCalledWith('/admin/settings');
});
it('localizes a success receipt through the package catalog when it declares messageKey', async () => {
  mocks.actions = [
    {
      id: 'save',
      method: 'POST',
      path: '/storage/config',
      permission: 'storage.admin',
      successFeedback: {
        messageKey: 'action.saved',
        message: '已保存',
        params: { updated: 'updated' },
      },
    },
  ];
  mocks.extraManifest = {
    messages: {
      'zh-CN': { 'action.saved': '已保存 {updated} 项' },
      'en-US': { 'action.saved': 'Saved {updated} item(s)' },
    },
  };
  mocks.post.mockResolvedValue({ updated: 2 });
  await expect(
    executePluginAction('storage', 'save', '/admin/settings#storage', new FormData()),
  ).resolves.toEqual({ ok: true, message: '已保存 2 项' });
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
  ).resolves.toEqual({ ok: false, error: expect.stringMatching(/权限|无权|拒绝/) });
  expect(mocks.post).not.toHaveBeenCalled();
  expect(mocks.revalidate).not.toHaveBeenCalled();
  expect(mocks.redirect).not.toHaveBeenCalled();
});

it('keeps the local session when a plugin returns an upstream 401', async () => {
  mocks.post.mockRejectedValue(
    new ApiError('上游凭证被拒绝', {
      status: 401,
      code: 'zjmf.client.credentials_rejected',
    }),
  );

  // 本地会话保留，且不把上游文案直接上屏：按 ADR-0012 只给稳定错误码的本地文案。
  await expect(
    executePluginAction('storage', 'save', '/admin/settings#plugin-storage-%2Fconfig', new FormData()),
  ).resolves.toEqual({ ok: false, error: '保存失败', code: 'zjmf.client.credentials_rejected' });

  expect(mocks.deleteCookie).not.toHaveBeenCalled();
  expect(mocks.redirect).not.toHaveBeenCalled();
});

it('carries the kernel request id so the inline failure can be traced', async () => {
  mocks.post.mockRejectedValue(
    new ApiError('分发请求失败', {
      status: 409,
      code: 'market.installFailed',
      requestId: 'req-abc123',
    }),
  );

  // ADR-0012 keeps `detail` out of the UI, so the id is the only link between
  // 「安装失败」 on screen and the cause in the server log.
  await expect(
    executePluginAction('storage', 'save', '/admin/settings#storage', new FormData()),
  ).resolves.toEqual({
    ok: false,
    error: '保存失败',
    requestId: 'req-abc123',
    code: 'market.installFailed',
  });
});
