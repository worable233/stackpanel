import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 请求级去重：布局与页面重复读同一份 shell 数据。
 *
 * 现场：`/account`、`/account/settings`、`/admin/*` 慢。
 *
 * 根因不是某个接口慢，而是**同一份数据在一次渲染里被读了好几遍**：
 * Next 的 `layout.tsx` 和它下面的 `page.tsx` 是两个独立组件，各自执行：
 *
 *   - `account/layout.tsx` 读 `getCurrentUser()` + `getNav('account')`
 *   - `account/settings/page.tsx` **又**读一遍这两样
 *   - 根 `layout.tsx` 的 `generateMetadata` 读 `platform/info` + `platform/brand`
 *   - `FrontendRoute` 在页面组件里**又**读一遍
 *
 * 每次都是一次 HTTP + 鉴权 + 权限计算 + DB 查询。
 *
 * ## 为什么这些测试只断言"降级与失败语义"
 *
 * 去重本身由 React `cache()` 提供，而 `cache()` **只在 Next 的渲染上下文里
 * 生效**——在纯 Node 测试进程里没有渲染作用域，`cache()` 等价于直接调用。
 * 实测确认：在 vitest 里连续调用 3 次，被调函数会执行 3 次。
 *
 * 所以"是否真的去重"不能用单元测试证明，只能对**运行中的服务**数内核请求
 * 次数（见 `scripts/measure-request-fanout.py`，实测 `/login` 单次渲染从
 * 15 次降到 10 次、每个端点恰好一次）。
 *
 * 这里保留的是能确定性验证的部分：失败降级、失败不缓存。
 */

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getNav: vi.fn(),
  getPlatformInfo: vi.fn(),
  getPlatformBrand: vi.fn(),
  getActiveTheme: vi.fn(),
  checkPermission: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', () => ({
  getAuthedApiClient: async () => ({
    getCurrentUser: mocks.getCurrentUser,
    getNav: mocks.getNav,
    checkPermission: mocks.checkPermission,
  }),
  getApiClient: () => ({
    getPlatformInfo: mocks.getPlatformInfo,
    getPlatformBrand: mocks.getPlatformBrand,
    getActiveTheme: mocks.getActiveTheme,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUser.mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
  mocks.getNav.mockResolvedValue({ items: [] });
  mocks.getPlatformInfo.mockResolvedValue({
    platform: { name: 'Panel', description: 'd', url: null, brandDisplay: 'both' },
  });
  mocks.getPlatformBrand.mockResolvedValue({ brand: { logo: null, favicon: null } });
  mocks.getActiveTheme.mockResolvedValue({ theme: { id: 'atlas' } });
  mocks.checkPermission.mockResolvedValue({ allowed: true });
});

describe('platform fallbacks', () => {
  it('falls back to defaults instead of failing the render', async () => {
    const { requestPlatformInfo, requestPlatformBrand } = await import(
      '@/lib/platform-request-cache'
    );
    mocks.getPlatformInfo.mockRejectedValue(new Error('kernel down'));
    mocks.getPlatformBrand.mockRejectedValue(new Error('kernel down'));

    // 内核抖一下不能让页面 500：平台信息缺失只影响标题/图标。
    await expect(requestPlatformInfo()).resolves.toMatchObject({ name: expect.any(String) });
    await expect(requestPlatformBrand()).resolves.toBeNull();
  });

  it('falls back to no theme when the theme endpoint fails', async () => {
    const { requestActiveTheme } = await import('@/lib/platform-request-cache');
    mocks.getActiveTheme.mockRejectedValue(new Error('kernel down'));

    // 主题读不到时宿主样式表要退回内置默认，而不是整个页面崩掉。
    await expect(requestActiveTheme()).resolves.toEqual({ theme: null });
  });
});

describe('permission fallback', () => {
  it('denies instead of throwing when the permission check fails', async () => {
    const { requestPermission } = await import('@/lib/shell-request-cache');
    mocks.checkPermission.mockRejectedValue(new Error('kernel down'));

    // 权限检查失败必须 fail-closed：宁可少显示一个入口，也不能放行。
    await expect(requestPermission('store.admin')).resolves.toBe(false);
  });

  it('reports the granted value when the kernel allows it', async () => {
    const { requestPermission } = await import('@/lib/shell-request-cache');
    await expect(requestPermission('store.admin')).resolves.toBe(true);
  });
});
