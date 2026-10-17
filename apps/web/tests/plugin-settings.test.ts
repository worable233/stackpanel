import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  candidates: [] as Array<{ id: string; manifest: Record<string, unknown> }>,
  checkPermission: vi.fn(),
  finder: vi.fn(),
  bindActions: vi.fn(() => ({})),
}));
vi.mock('@/lib/slots', () => ({
  candidateAdmitsServerExecution: () => true,
  listPluginFrontendCandidates: async () => mocks.candidates,
  importFrontendPackage: async () => ({ finders: { config: { handler: mocks.finder } } }),
  readPluginSettings: async () => ({}),
}));
vi.mock('@/lib/api', () => ({
  apiAssetUrl: (path: string) => path,
  getAuthedApiClient: async () => ({
    checkPermission: mocks.checkPermission,
    recordFrontendAudit: async () => undefined,
  }),
}));
vi.mock('@/lib/frontend-plugin-actions', () => ({ bindPluginActions: mocks.bindActions }));
// Menu / system-settings labels are resolved through the package catalog for the
// request locale; these unit tests run outside a request scope (ADR-0016 §5).
vi.mock('@/i18n/locale', () => ({ getLocale: async () => 'zh-CN' }));
import { getPluginSettingsSections, getPluginAdminMenus } from '@/lib/admin-frontend';
import { adminRouteSchema } from '@stackpanel/sdk';

const route = {
  path: '/config',
  component: 'config',
  permission: 'storage.admin',
  systemSettings: { label: '存储', order: 10 },
  nav: { label: '存储' },
  data: [{ finder: 'config', as: 'config' }],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.candidates = [{ id: 'storage', manifest: { adminRoutes: [route], actions: [] } }];
  mocks.checkPermission.mockResolvedValue({ allowed: true });
  mocks.finder.mockResolvedValue({ kind: 'env' });
});
describe('plugin system settings', () => {
  it('preserves settings metadata through manifest parsing', () => {
    expect(adminRouteSchema.parse(route).systemSettings).toEqual({ label: '存储', order: 10 });
  });
  it('reuses the authorized route, finder and actions without a duplicate global menu', async () => {
    const sections = await getPluginSettingsSections();
    expect(sections).toHaveLength(1);
    expect(sections[0]?.result).toMatchObject({ status: 'ok', data: { config: { kind: 'env' } } });
    expect(mocks.bindActions).toHaveBeenCalledWith(
      'storage',
      [],
      '/admin/settings#plugin-storage-%2Fconfig',
    );
    expect(await getPluginAdminMenus()).toEqual([]);
  });
  it('does not expose disabled plugins or execute their finders', async () => {
    mocks.candidates = [];
    expect(await getPluginSettingsSections()).toEqual([]);
    expect(mocks.finder).not.toHaveBeenCalled();
  });
  it('does not expose forbidden sections or execute their finders', async () => {
    mocks.checkPermission.mockResolvedValue({ allowed: false });
    expect(await getPluginSettingsSections()).toEqual([]);
    expect(mocks.finder).not.toHaveBeenCalled();
  });
  it('keeps settings sections for different paths distinct and excludes parameterized routes', async () => {
    mocks.candidates[0]!.manifest.adminRoutes = [
      route,
      { ...route, path: '/other' },
      { ...route, path: '/:id' },
    ];
    const sections = await getPluginSettingsSections();
    expect(sections).toHaveLength(2);
    expect(new Set(sections.map((s) => s.id)).size).toBe(2);
  });
});
