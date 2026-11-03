import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 布局与页面重复读同一份 shell 数据。
 *
 * 现场：`/account/settings` 慢、`/admin/*` 慢。
 *
 * 根因不是某个接口慢，而是**同一份数据在一次渲染里被读了好几遍**：
 * Next 的 `layout.tsx` 和它下面的 `page.tsx` 是两个独立组件，各自执行：
 *
 *   - `account/layout.tsx` 读 `getCurrentUser()` + `getNav('account')`
 *   - `account/settings/page.tsx` **又**读一遍这两样
 *   - `admin/layout.tsx` 读 `getNav('admin')` + `getCurrentUser()`
 *   - 各 admin 页面再读一次
 *
 * 每次都是一次 HTTP + 鉴权 + 权限计算 + DB 查询。
 *
 * 修法：把只读调用按请求去重（缓存的是 Promise 本身，所以**并发调用也合并**
 * —— React 的 `cache()` 做不到这点，`Promise.all` 里仍然会执行两次）。
 *
 * 这里断言的是**调用次数**：次数错了，耗时就一定错。
 */

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getNav: vi.fn(),
  getPlatformInfo: vi.fn(),
  getPlatformBrand: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', () => ({
  getAuthedApiClient: async () => ({
    getCurrentUser: mocks.getCurrentUser,
    getNav: mocks.getNav,
  }),
  getApiClient: () => ({
    getPlatformInfo: mocks.getPlatformInfo,
    getPlatformBrand: mocks.getPlatformBrand,
  }),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  // 每个用例一份干净的请求快照：否则会命中上一个用例缓存下来的 Promise。
  const { resetFrontendSnapshot } = await import('@/lib/frontend-snapshot');
  resetFrontendSnapshot();

  mocks.getCurrentUser.mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
  mocks.getNav.mockResolvedValue({ items: [{ label: 'Home', href: '/' }] });
  mocks.getPlatformInfo.mockResolvedValue({
    platform: { name: 'Panel', description: 'd', url: null, brandDisplay: 'both' },
  });
  mocks.getPlatformBrand.mockResolvedValue({ brand: { logo: null, favicon: null } });
});

describe('shell request cache', () => {
  it('reads the current user once per request no matter how many callers ask', async () => {
    const { requestCurrentUser } = await import('@/lib/shell-request-cache');

    // 布局 + 页面 + 侧边栏同时要用户信息（并发发起）。
    await Promise.all([requestCurrentUser(), requestCurrentUser(), requestCurrentUser()]);
    await requestCurrentUser();

    expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it('reads each nav surface once per request but keeps surfaces distinct', async () => {
    const { requestNav } = await import('@/lib/shell-request-cache');

    await Promise.all([requestNav('account'), requestNav('account'), requestNav('admin')]);
    await requestNav('account');

    // account 一次、admin 一次；重复调用不再打内核。
    expect(mocks.getNav).toHaveBeenCalledTimes(2);
    expect(mocks.getNav).toHaveBeenCalledWith('account');
    expect(mocks.getNav).toHaveBeenCalledWith('admin');
  });

  it('reads platform info and brand once each per request', async () => {
    const { requestPlatformInfo, requestPlatformBrand } = await import(
      '@/lib/platform-request-cache'
    );

    // 根 layout 的 metadata、SEO canonical、FrontendRoute 都要读。
    await Promise.all([
      requestPlatformInfo(),
      requestPlatformInfo(),
      requestPlatformBrand(),
      requestPlatformBrand(),
    ]);

    expect(mocks.getPlatformInfo).toHaveBeenCalledTimes(1);
    expect(mocks.getPlatformBrand).toHaveBeenCalledTimes(1);
  });

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

  it('does not cache a failed lookup for the rest of the request', async () => {
    const { requestCurrentUser } = await import('@/lib/shell-request-cache');
    mocks.getCurrentUser.mockRejectedValueOnce(new Error('kernel down'));

    // 一次抖动不该把整页钉死在错误上：失败必须释放缓存，让后续调用重试。
    await expect(requestCurrentUser()).rejects.toThrow();
    mocks.getCurrentUser.mockResolvedValue({ user: { id: 'u1', role: 'USER' } });
    await expect(requestCurrentUser()).resolves.toMatchObject({ user: { id: 'u1' } });
  });
});
