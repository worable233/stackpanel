import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrontendManifest } from '@stackpanel/sdk';

/**
 * The web layer must never hand the browser a URL that is guaranteed to 404.
 *
 * `runtimeAdminModuleUrl` unconditionally appends `dist/admin.runtime.js`, but a
 * package built before runtime loading only ships `dist/admin.js` — its bare host
 * ABI specifiers are unbrowserable. The kernel back-fills the runtime variant and
 * declares it in `manifest.files`; the web side only emits the URL when that
 * declaration is present.
 */

const mocks = vi.hoisted(() => ({
  candidates: [] as Array<{
    id: string;
    revision?: string;
    manifest: unknown;
  }>,
  finder: vi.fn(async () => ({})),
}));

vi.mock('@/lib/slots', () => ({
  candidateAdmitsServerExecution: () => true,
  listPluginFrontendCandidates: async () => mocks.candidates,
  importFrontendPackage: async () => ({ finders: { config: mocks.finder } }),
  readPluginSettings: async () => ({}),
}));
vi.mock('@/lib/api', () => ({
  apiAssetUrl: (path: string) => `/api${path}`,
  getAuthedApiClient: async () => ({
    checkPermission: async () => ({ allowed: true }),
    recordFrontendAudit: async () => undefined,
  }),
}));
vi.mock('@/lib/frontend-plugin-actions', () => ({ bindPluginActions: () => ({}) }));
vi.mock('@/i18n/locale', () => ({ getLocale: async () => 'zh-CN' }));

import { resolvePluginAdminRoute } from '@/lib/admin-frontend';

function manifest(files: string[]): FrontendManifest {
  return {
    version: '1.0.0',
    revision: '',
    entry: 'frontend/dist/index.js',
    pages: [],
    layouts: [],
    finders: [],
    adminRoutes: [{ path: '/overview', component: 'admin/overview' }],
    adminActions: [],
    actions: [],
    accountRoutes: [],
    accountWidgets: [],
    files,
    styles: [],
    locales: [],
  } as unknown as FrontendManifest;
}

beforeEach(() => {
  mocks.candidates = [];
});

describe('resolvePluginAdminRoute runtime admin entry', () => {
  it('emits the versioned runtime URL when the package ships the variant', async () => {
    mocks.candidates = [
      {
        id: 'notice',
        revision: 'fa1c426807b4',
        manifest: manifest(['frontend/dist/index.js', 'frontend/dist/admin.runtime.js']),
      },
    ];
    const result = await resolvePluginAdminRoute('notice', '/overview');
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' ? result.runtimeAdminModuleUrl : null).toBe(
      '/api/plugins/notice/frontend/fa1c426807b4/dist/admin.runtime.js',
    );
  });

  it('omits the URL for a legacy package that only ships admin.js', async () => {
    mocks.candidates = [
      {
        id: 'legacy',
        revision: 'abc123def456',
        manifest: manifest(['frontend/dist/index.js', 'frontend/dist/admin.js']),
      },
    ];
    const result = await resolvePluginAdminRoute('legacy', '/overview');
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && 'runtimeAdminModuleUrl' in result).toBe(false);
  });

  it('does not emit the URL when the manifest has no files list at all', async () => {
    const bare = manifest([]);
    mocks.candidates = [{ id: 'empty', revision: 'abc123def456', manifest: bare }];
    const result = await resolvePluginAdminRoute('empty', '/overview');
    expect(result.status === 'ok');
    expect(result.status === 'ok' && 'runtimeAdminModuleUrl' in result).toBe(false);
  });
});
