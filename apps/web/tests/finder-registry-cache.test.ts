import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「页面进入很慢」的插件扫描放大问题。
 *
 * 现场：`/account`、`/account/services`、`/admin/plugin/<id>/*` 这些页面慢。
 *
 * 根因不是单个请求慢，而是**同一个全量扫描被重复做了很多遍**：
 *
 *   - `executeAccountFinder` 每次调用都「列出全部插件候选 → 逐个 import 前端包
 *     → 逐个读插件设置」。`/account` 首页一次要 4 个 finder，就是 4 遍全量扫描。
 *   - `resolvePluginAdminRoute` 自己又遍历一遍全部插件包，只为合并 finders。
 *
 * 插件越多，这些页面越慢，而同一个请求里结果完全一样。
 *
 * 修法：把「合并 finders + 归属插件」放进请求级快照（`frontendSnapshot`），
 * 一次扫描、全请求复用。这里断言的是**扫描次数**，不是耗时 —— 次数错了，
 * 耗时就一定错。
 */

const mocks = vi.hoisted(() => ({
  listCandidates: vi.fn(),
  importPackage: vi.fn(),
  readSettings: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('server-only', () => ({}));
// 只替换 slots 的依赖，保留被测实现本身（合并 + 请求级缓存）。
vi.mock('@/lib/frontend-runtime', () => ({
  runtimeFrontendLoadingEnabled: () => false,
  loadRuntimeFrontend: async () => null,
  runtimeFrontendFailure: () => null,
}));
vi.mock('@/lib/frontend-registry', () => ({
  getFrontendPackage: (kind: string, id: string) => mocks.importPackage(kind, id),
  listFrontendPackageIds: () => [],
}));
// 候选列表来自内核的 `/plugins/frontends`；测试里直接给固定值，并统计调用次数。
vi.mock('@/lib/api', () => ({
  apiAssetUrl: (path: string) => path,
  getApiClient: () => ({
    getPluginFrontends: () => mocks.listCandidates(),
  }),
  getAuthedApiClient: () => mocks.getClient(),
}));
beforeEach(async () => {
  vi.clearAllMocks();
  // `listPluginFrontendCandidates` 走 5s 的跨请求缓存（`remember`）。不重置的话
  // 后一个用例会读到前一个用例缓存的候选列表，测出来的不是本用例的行为。
  const { resetCache } = await import('@/lib/server-cache');
  resetCache();
  // `frontendSnapshot()` 用 `enterWith` 挂到当前异步上下文上，会跨用例残留；
  // 不重置的话后一个用例会命中前一个用例缓存的 finders。
  const { resetFrontendSnapshot } = await import('@/lib/frontend-snapshot');
  resetFrontendSnapshot();
  mocks.readSettings.mockResolvedValue({});
  mocks.getClient.mockResolvedValue({});
  // manifest 必须是合法形状：`isFrontendPackage` 会按它校验包（缺字段会被
  // 当成「包坏了」直接丢弃，测试就会看到零次 import 而不是缓存生效）。
  const manifest = {
    version: '1',
    revision: 'r1',
    entry: 'dist/index.js',
    pages: [],
    layouts: [],
    finders: ['store.myServices', 'ticket.pendingCount', 'shared'],
    adminRoutes: [],
    adminActions: [],
    actions: [],
    accountRoutes: [],
    accountWidgets: [],
    adminMenus: [],
    messages: {},
    files: [],
  };
  // `getPluginFrontends()` 的返回形状是 `{ plugins }`，不是裸数组。
  mocks.listCandidates.mockResolvedValue({
    plugins: [
      // 信任门默认开启：未显式准入的包不会在 web 进程执行（会被静默跳过）。
      { kind: 'plugins', id: 'store', manifest, revision: 'r1', serverExecution: 'allowed' },
      { kind: 'plugins', id: 'ticket', manifest, revision: 'r1', serverExecution: 'allowed' },
    ],
  });
});

/**
 * 缓存语义的独立验证：不依赖 Next 的请求上下文。
 *
 * `mergedPluginFinders` 依赖 `AsyncLocalStorage`，在测试里没有活动请求，
 * `frontendSnapshot()` 会现建一个 —— 同一个异步上下文内多次调用应当命中。
 */
describe('finder registry is scanned once per request', () => {
  it('imports each plugin package at most once across many finder lookups', async () => {
    const { runWithFrontendSnapshot } = await import('@/lib/frontend-snapshot');
    const { mergedPluginFinders } = await import('@/lib/slots');

    // `getFrontendPackage` 是**同步**的：mock 必须同步返回值，返回 Promise
    // 会让 `isFrontendPackage` 判成「包坏了」而静默丢弃。
    mocks.importPackage.mockImplementation((_kind: string, id: string) => ({
      ui: {},
      finders:
        id === 'store'
          ? { 'store.myServices': { handler: async () => [] } }
          : { 'ticket.pendingCount': { handler: async () => ({ count: 0 }) } },
    }));

    await runWithFrontendSnapshot(async () => {
      // 模拟 /account 首页：多个 finder 需求。
      await mergedPluginFinders();
      await mergedPluginFinders();
      await mergedPluginFinders();
      await mergedPluginFinders();
    });

    // 两个插件各 import 一次，而不是 4 次调用 × 2 个插件 = 8 次。
    expect(mocks.importPackage).toHaveBeenCalledTimes(2);
    expect(mocks.listCandidates).toHaveBeenCalledTimes(1);
  });

  it('exposes finder ownership so settings come from the providing plugin', async () => {
    const { runWithFrontendSnapshot } = await import('@/lib/frontend-snapshot');
    const { mergedPluginFinders, finderOwnerPlugin } = await import('@/lib/slots');

    mocks.importPackage.mockImplementation((_kind: string, id: string) => ({
      ui: {},
      finders:
        id === 'store'
          ? { 'store.myServices': { handler: async () => [] } }
          : { 'ticket.pendingCount': { handler: async () => ({ count: 0 }) } },
    }));

    await runWithFrontendSnapshot(async () => {
      // 用错插件的设置会让 finder 读到别人的配置。
      expect(await finderOwnerPlugin('store.myServices')).toBe('store');
      expect(await finderOwnerPlugin('ticket.pendingCount')).toBe('ticket');
      expect(await finderOwnerPlugin('nope')).toBeNull();
    });
  });

  it('keeps first-wins semantics when two plugins export the same finder name', async () => {
    const { runWithFrontendSnapshot } = await import('@/lib/frontend-snapshot');
    const { mergedPluginFinders, finderOwnerPlugin } = await import('@/lib/slots');

    mocks.importPackage.mockImplementation((_kind: string, id: string) => ({
      finders: { shared: { handler: async () => id } },
      ui: {},
    }));

    await runWithFrontendSnapshot(async () => {
      const merged = await mergedPluginFinders();
      // 与原先「遍历顺序第一个胜出」一致，否则同名 finder 会静默换实现。
      expect(await merged.shared.handler({}, { settings: {}, api: {} as never, params: {} })).toBe('store');
      expect(await finderOwnerPlugin('shared')).toBe('store');
    });
  });
});
